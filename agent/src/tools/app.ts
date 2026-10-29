import type { Tool, ToolClass, ToolResult } from "../types.ts";
import { fail } from "./util.ts";
import { isTerminalProgram } from "../routing.ts";
import { CONSOLE_CHECK_PS, blockedMessage, parseBlocked, psq, runPowerShell as makeRunner } from "./ps.ts";
import type { ScriptRunner } from "./ps.ts";

// Background desktop-app control for Windows: Microsoft UI Automation (the accessibility API) driven from one PowerShell process.
// It never moves the mouse, never injects keystrokes, never takes focus and takes no screenshot unless asked. Every control is reached
// through a UIA pattern (Invoke, Value, Toggle, SelectionItem, ExpandCollapse, Text, Window). One call runs a whole list of steps.
// Terminals, consoles and the Run box are refused (use bash). The steps travel as JSON data inside a here-string, never as code.

const ACTIONS = ["list_windows", "tree", "find", "invoke", "set_value", "get_text", "select", "toggle", "expand", "collapse", "launch", "close", "wait"] as const;
export type AppAction = (typeof ACTIONS)[number];
/** Actions that only read; a call made only of these is class "read" (no permission prompt). */
const READ_ACTIONS = new Set<AppAction>(["list_windows", "tree", "find", "get_text", "wait"]);
const NEEDS_SELECTOR = new Set<AppAction>(["find", "invoke", "set_value", "get_text", "select", "toggle", "expand", "collapse", "wait"]);
const NEEDS_WINDOW = new Set<AppAction>(["tree", "find", "invoke", "set_value", "get_text", "select", "toggle", "expand", "collapse", "close", "wait"]);

const MAX_STEPS = 40;
const MAX_VALUE = 20_000;
const SCRIPT_TIMEOUT_MS = 60_000;

export interface AppStep {
  action: AppAction;
  window?: string;
  name?: string; type?: string; id?: string; exact?: boolean; index?: number;
  value?: string; max?: number; depth?: number; all?: boolean;
  state?: "on" | "off"; add?: boolean;
  app?: string; args?: string; timeout_s?: number;
}

const STR_FIELDS = ["window", "name", "type", "id", "value", "app", "args"] as const;

const CONTROL_TYPE = /^[A-Za-z]{2,24}$/;

/** Validates the call's arguments into a list of steps, carrying `window` from the previous step. Errors are written for the model. */
export function normalizeSteps(args: Record<string, unknown>): { steps: AppStep[]; shot: boolean; stopOnError: boolean } | { error: string } {
  const rawList: unknown[] = Array.isArray(args.steps) ? args.steps : [args];
  if (!rawList.length) return { error: "steps is empty" };
  if (rawList.length > MAX_STEPS) return { error: `at most ${MAX_STEPS} steps per call; send the rest in a second call` };
  const defaultWindow = typeof args.window === "string" && args.window.trim() ? args.window.trim() : undefined;
  let carry = defaultWindow;
  const steps: AppStep[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const r = rawList[i] as Record<string, unknown> | null;
    const label = rawList.length > 1 ? `step ${i + 1}: ` : "";
    if (!r || typeof r !== "object") return { error: `${label}not a step` };
    const action = r.action as AppAction;
    if (!ACTIONS.includes(action)) return { error: `${label}action must be one of ${ACTIONS.join(", ")}` };
    const st: AppStep = { action };
    for (const k of STR_FIELDS) {
      const v = r[k];
      if (v === undefined || v === null) continue;
      if (typeof v !== "string") return { error: `${label}${k} must be a string` };
      (st as unknown as Record<string, unknown>)[k] = k === "value" ? v : v.trim();
    }
    if (st.value !== undefined && st.value.length > MAX_VALUE) return { error: `${label}value is over ${MAX_VALUE} characters` };
    if (!st.window && action !== "launch") st.window = carry;
    if (st.window) carry = st.window;
    if (st.name === "") delete st.name;
    if (st.type !== undefined && !CONTROL_TYPE.test(st.type)) return { error: `${label}type must be a UI Automation control type such as Button, Edit, MenuItem, CheckBox, ComboBox, ListItem, TabItem, Document` };
    if (typeof r.exact === "boolean") st.exact = r.exact;
    if (typeof r.all === "boolean") st.all = r.all;
    if (typeof r.add === "boolean") st.add = r.add;
    if (r.index !== undefined) { const n = Number(r.index); if (!Number.isInteger(n) || n < 0 || n > 200) return { error: `${label}index must be a whole number from 0 to 200` }; st.index = n; }
    if (r.depth !== undefined) { const n = Number(r.depth); if (!Number.isInteger(n) || n < 1 || n > 8) return { error: `${label}depth must be 1 to 8` }; st.depth = n; }
    if (r.max !== undefined) { const n = Number(r.max); if (!Number.isInteger(n) || n < 1 || n > MAX_VALUE) return { error: `${label}max must be 1 to ${MAX_VALUE}` }; st.max = n; }
    if (r.timeout_s !== undefined) { const n = Number(r.timeout_s); if (!Number.isFinite(n) || n <= 0 || n > 30) return { error: `${label}timeout_s must be between 0 and 30` }; st.timeout_s = n; }
    if (r.state !== undefined) { if (r.state !== "on" && r.state !== "off") return { error: `${label}state must be "on" or "off"` }; st.state = r.state; }
    if (NEEDS_WINDOW.has(action) && !st.window) return { error: `${label}${action} needs window (part of the window title, the process name, or pid:123; list_windows shows them)` };
    if (NEEDS_SELECTOR.has(action) && action !== "wait" && !st.name && !st.type && !st.id) return { error: `${label}${action} needs name, type or id to pick the control (tree or find shows them)` };
    if (action === "wait" && !st.name && !st.type && !st.id) return { error: `${label}wait needs name, type or id` };
    if (action === "set_value" && st.value === undefined) return { error: `${label}set_value needs value` };
    if (action === "launch") {
      if (!st.app) return { error: `${label}launch needs app (a program name or path)` };
      if (isTerminalProgram(st.app)) return { error: `${label}refused: ${st.app} is a terminal or shell. ${blockedHint}` };
    }
    steps.push(st);
  }
  return { steps, shot: args.screenshot === true, stopOnError: args.continue_on_error !== true };
}

const blockedHint = "Run the command with the bash tool (short) or the process tool (long, background). Never on screen.";

/** The window the final screenshot (screenshot:true) is taken of: the last step's window. */
const lastWindow = (steps: AppStep[]): string | undefined => [...steps].reverse().find((s) => s.window)?.window;

// The interpreter. It is a fixed script: the only per-call part is the JSON line near the top, so a step can never become code.
const PS_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$script:pc = @{}
$script:pending = $false
$script:note = ''
$script:walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
[void][Daebot.Cap]::SetProcessDPIAware()

function Short($s, [int]$n) {
  if ($null -eq $s) { return '' }
  $t = ([string]$s -replace '\s+', ' ').Trim()
  if ($t.Length -gt $n) { return $t.Substring(0, $n - 1) + '...' }
  return $t
}
function Proc-Name([int]$id) {
  if ($script:pc.ContainsKey($id)) { return $script:pc[$id] }
  $n = ''
  try { $n = (Get-Process -Id $id -ErrorAction Stop).ProcessName } catch { }
  $script:pc[$id] = $n
  return $n
}
function Get-Wins {
  $kids = $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
  $res = @()
  foreach ($w in $kids) {
    $c = $w.Current
    if ($c.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $c.Name) { $res += $w }
  }
  return $res
}
function Guard-Window($w) {
  $c = $w.Current
  Block-IfConsole ([pscustomobject]@{ Proc = (Proc-Name $c.ProcessId); Class = $c.ClassName; Title = $c.Name })
}
function Find-Win($spec) {
  if (-not $spec) { throw 'window is required (part of the title, the process name, or pid:123)' }
  $spec = [string]$spec
  $wins = @(Get-Wins)
  $m = @()
  if ($spec -match '^pid:(\d+)$') {
    $want = [int]$Matches[1]
    $m = @($wins | Where-Object { $_.Current.ProcessId -eq $want })
  } else {
    $pat = '*' + [System.Management.Automation.WildcardPattern]::Escape($spec) + '*'
    $m = @($wins | Where-Object { ($_.Current.Name -like $pat) -or ((Proc-Name $_.Current.ProcessId) -eq $spec) })
    $exact = @($m | Where-Object { $_.Current.Name -eq $spec })
    if ($exact.Count -gt 0) { $m = $exact }
  }
  if ($m.Count -eq 0) { throw ("no window matches '" + $spec + "'. Use list_windows to see the open windows.") }
  $w = $m[0]
  Guard-Window $w
  if ($m.Count -gt 1) { $script:note = ' (' + $m.Count + ' windows match; used "' + (Short $w.Current.Name 40) + '", pass pid:N to pick another)' }
  return $w
}
function Get-CT($name) {
  if (-not $name) { return $null }
  $f = [System.Windows.Automation.ControlType].GetField([string]$name, [System.Reflection.BindingFlags]'Public,Static,IgnoreCase')
  if ($null -eq $f) { throw ("unknown control type '" + $name + "'") }
  return $f.GetValue($null)
}
function Find-Els($win, $st, [int]$max) {
  $conds = @()
  $ct = Get-CT $st.type
  if ($null -ne $ct) { $conds += [System.Windows.Automation.PropertyCondition]::new($AE::ControlTypeProperty, $ct) }
  if ($st.id) { $conds += [System.Windows.Automation.PropertyCondition]::new($AE::AutomationIdProperty, [string]$st.id) }
  $nm = [string]$st.name
  $res = @()
  if ($nm) {
    $withName = $conds + [System.Windows.Automation.PropertyCondition]::new($AE::NameProperty, $nm, [System.Windows.Automation.PropertyConditionFlags]::IgnoreCase)
    if ($withName.Count -eq 1) { $cond = $withName[0] } else { $cond = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$withName) }
    foreach ($e in $win.FindAll($TS::Descendants, $cond)) { $res += $e; if ($res.Count -ge $max) { break } }
    if ($res.Count -gt 0 -or $st.exact -eq $true) { return $res }
  }
  if ($conds.Count -eq 0) { $cond = [System.Windows.Automation.Condition]::TrueCondition }
  elseif ($conds.Count -eq 1) { $cond = $conds[0] }
  else { $cond = [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$conds) }
  $seen = 0
  foreach ($e in $win.FindAll($TS::Descendants, $cond)) {
    $seen++
    if ($seen -gt 4000) { break }
    if ($nm) {
      $en = $e.Current.Name
      if ([string]::IsNullOrEmpty($en) -or $en.IndexOf($nm, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    }
    $res += $e
    if ($res.Count -ge $max) { break }
  }
  return $res
}
function Describe-Sel($st) {
  $p = @()
  if ($st.name) { $p += ('name "' + $st.name + '"') }
  if ($st.type) { $p += ('type ' + $st.type) }
  if ($st.id) { $p += ('id ' + $st.id) }
  return ($p -join ', ')
}
function Pick-El($win, $st) {
  $els = @(Find-Els $win $st 60)
  $idx = 0
  if ($null -ne $st.index) { $idx = [int]$st.index }
  if ($els.Count -eq 0) { throw ('no control matches ' + (Describe-Sel $st) + ' in "' + (Short $win.Current.Name 40) + '". Use tree or find to see the names.') }
  if ($idx -ge $els.Count) { throw ('index ' + $idx + ' is out of range: only ' + $els.Count + ' controls match ' + (Describe-Sel $st)) }
  if ($els.Count -gt 1 -and $null -eq $st.index) { $script:note += ' (' + $els.Count + ' controls match, used #0; pass index to pick another)' }
  return $els[$idx]
}
function Pats($el) {
  $names = @()
  try { foreach ($p in $el.GetSupportedPatterns()) { $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' -replace '^.*\.', '') } } catch { }
  return ($names -join ', ')
}
function Tags($el) {
  $map = @{ Invoke = 'i'; Value = 'v'; Toggle = 't'; SelectionItem = 's'; ExpandCollapse = 'e'; Text = 'x'; Scroll = 'r'; RangeValue = 'n' }
  $t = @()
  try {
    foreach ($p in $el.GetSupportedPatterns()) {
      $k = ($p.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' -replace '^.*\.', '')
      if ($map.ContainsKey($k)) { $t += $map[$k] }
    }
  } catch { }
  if ($t.Count -eq 0) { return '' }
  return ' {' + ($t -join '') + '}'
}
function Fmt-El($e, [bool]$tags) {
  $c = $e.Current
  $s = '[' + ($c.ControlType.ProgrammaticName -replace '^ControlType\.', '') + ']'
  if ($c.Name) { $s += ' "' + (Short $c.Name 60) + '"' }
  if ($c.AutomationId) { $s += ' #' + $c.AutomationId }
  if (-not $c.IsEnabled) { $s += ' (disabled)' }
  if ($tags) { $s += (Tags $e) }
  return $s
}
function Need-Pat($el, $pat, [string]$verb) {
  $o = $null
  if ($el.TryGetCurrentPattern($pat, [ref]$o)) { return $o }
  throw ('control ' + (Fmt-El $el $false) + ' does not support ' + $verb + '. It supports: ' + (Pats $el) + '. Try another control (tree shows {i=invoke v=value t=toggle s=select e=expand x=text}).')
}
function Run-Timed([scriptblock]$sb, $el, [int]$ms) {
  $ps = [powershell]::Create()
  [void]$ps.AddScript($sb.ToString()).AddArgument($el)
  $h = $ps.BeginInvoke()
  if ($h.AsyncWaitHandle.WaitOne($ms)) {
    try { [void]$ps.EndInvoke($h) } finally { $ps.Dispose() }
    return $true
  }
  $script:pending = $true
  return $false
}
function Walk($el, [int]$d, [int]$maxd, [bool]$all) {
  $kid = $script:walker.GetFirstChild($el)
  while ($null -ne $kid) {
    if ($script:n -ge $script:maxn) { $script:trunc = $true; return }
    $off = $false
    try { $off = $kid.Current.IsOffscreen } catch { }
    if ($all -or -not $off) {
      $script:n++
      try { Write-Output (('  ' * $d) + (Fmt-El $kid $true)) } catch { Write-Output (('  ' * $d) + '[unreadable control]') }
      if ($d + 1 -lt $maxd) { Walk $kid ($d + 1) $maxd $all }
    }
    $next = $null
    try { $next = $script:walker.GetNextSibling($kid) } catch { }
    $kid = $next
  }
}
function Shot-Win($w) {
  $h = [IntPtr]$w.Current.NativeWindowHandle
  $r = New-Object Daebot.Cap+RC
  [void][Daebot.Cap]::GetWindowRect($h, [ref]$r)
  $wd = $r.R - $r.L
  $ht = $r.B - $r.T
  if ($wd -le 0 -or $ht -le 0) { throw 'the window has no size (is it minimized?)' }
  $bmp = New-Object System.Drawing.Bitmap $wd, $ht
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  [void][Daebot.Cap]::PrintWindow($h, $dc, 2)
  $g.ReleaseHdc($dc)
  $g.Dispose()
  $nw = [Math]::Min(1366, $wd)
  $nh = [int]($ht * $nw / $wd)
  $small = New-Object System.Drawing.Bitmap $bmp, $nw, $nh
  $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
  $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 70L
  $ms = New-Object System.IO.MemoryStream
  $small.Save($ms, $enc, $ep)
  Write-Output ('DAEBOT_APPSHOT {0} {1}' -f $nw, $nh)
  Write-Output ([Convert]::ToBase64String($ms.ToArray()))
}

function Run-Step($st) {
  switch -Exact ([string]$st.action) {
    'list_windows' {
      $filter = [string]$st.window
      foreach ($w in @(Get-Wins)) {
        $c = $w.Current
        $pn = Proc-Name $c.ProcessId
        if ($filter -and -not (($c.Name -like ('*' + [System.Management.Automation.WildcardPattern]::Escape($filter) + '*')) -or $pn -eq $filter)) { continue }
        $state = ''
        try {
          $wp = $null
          if ($w.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) { if ($wp.Current.WindowVisualState -eq 'Minimized') { $state = ' (minimized)' } }
        } catch { }
        Write-Output ('"' + (Short $c.Name 70) + '" ' + $pn + ' pid:' + $c.ProcessId + $state)
      }
    }
    'tree' {
      $win = Find-Win $st.window
      $root = $win
      if ($st.name -or $st.type -or $st.id) { $root = Pick-El $win $st }
      $depth = 3
      if ($null -ne $st.depth) { $depth = [int]$st.depth }
      $script:n = 0
      $script:maxn = 300
      $script:trunc = $false
      Write-Output (Fmt-El $root $true)
      Walk $root 1 ($depth + 1) ($st.all -eq $true)
      if ($script:trunc) { Write-Output '... (cut at 300 controls; pass name/id to start deeper, or a smaller depth)' }
    }
    'find' {
      $win = Find-Win $st.window
      $els = @(Find-Els $win $st 25)
      if ($els.Count -eq 0) { Write-Output ('no control matches ' + (Describe-Sel $st)) }
      else { $i = 0; foreach ($e in $els) { Write-Output ('#' + $i + ' ' + (Fmt-El $e $true)); $i++ } }
    }
    'invoke' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $pat = Need-Pat $el ([System.Windows.Automation.InvokePattern]::Pattern) 'invoke (click)'
      $sb = { param($e) $o = $null; if ($e.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$o)) { $o.Invoke() } }
      if (Run-Timed $sb $el 4000) { Write-Output ('invoked ' + (Fmt-El $el $false) + $script:note) }
      else { Write-Output ('sent invoke to ' + (Fmt-El $el $false) + '; the app is still busy, a dialog may be open (list_windows)' + $script:note) }
    }
    'set_value' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $vp = Need-Pat $el ([System.Windows.Automation.ValuePattern]::Pattern) 'set_value'
      if ($vp.Current.IsReadOnly) { throw ('control ' + (Fmt-El $el $false) + ' is read-only') }
      $vp.SetValue([string]$st.value)
      Write-Output ('set ' + (Fmt-El $el $false) + ' to ' + ([string]$st.value).Length + ' chars' + $script:note)
    }
    'get_text' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $max = 4000
      if ($null -ne $st.max) { $max = [int]$st.max }
      $o = $null
      $text = $null
      if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$o)) { $text = $o.DocumentRange.GetText($max) }
      elseif ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$o)) { $text = $o.Current.Value }
      else { $text = $el.Current.Name }
      if ($null -eq $text) { $text = '' }
      if ($text.Length -gt $max) { $text = $text.Substring(0, $max) + ' ...[cut]' }
      Write-Output ('text of ' + (Fmt-El $el $false) + $script:note + ':')
      Write-Output $text
    }
    'select' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $sp = Need-Pat $el ([System.Windows.Automation.SelectionItemPattern]::Pattern) 'select'
      if ($st.add -eq $true) { $sp.AddToSelection() } else { $sp.Select() }
      Write-Output ('selected ' + (Fmt-El $el $false) + $script:note)
    }
    'toggle' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $tp = Need-Pat $el ([System.Windows.Automation.TogglePattern]::Pattern) 'toggle'
      if ($st.state) {
        $want = 'Off'
        if ($st.state -eq 'on') { $want = 'On' }
        $tries = 0
        while ([string]$tp.Current.ToggleState -ne $want -and $tries -lt 3) { $tp.Toggle(); $tries++ }
      } else { $tp.Toggle() }
      Write-Output ('toggle ' + (Fmt-El $el $false) + ' is now ' + [string]$tp.Current.ToggleState + $script:note)
    }
    'expand' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $xp = Need-Pat $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'expand'
      $xp.Expand()
      Write-Output ('expanded ' + (Fmt-El $el $false) + $script:note)
    }
    'collapse' {
      $win = Find-Win $st.window
      $el = Pick-El $win $st
      $xp = Need-Pat $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern) 'collapse'
      $xp.Collapse()
      Write-Output ('collapsed ' + (Fmt-El $el $false) + $script:note)
    }
    'close' {
      $win = Find-Win $st.window
      $wp = Need-Pat $win ([System.Windows.Automation.WindowPattern]::Pattern) 'close'
      $title = Short $win.Current.Name 50
      $wp.Close()
      Write-Output ('closed window "' + $title + '"' + $script:note)
    }
    'wait' {
      $win = Find-Win $st.window
      $to = 5
      if ($null -ne $st.timeout_s) { $to = [double]$st.timeout_s }
      $until = (Get-Date).AddSeconds($to)
      $els = @()
      do {
        $els = @(Find-Els $win $st 1)
        if ($els.Count -eq 0) { Start-Sleep -Milliseconds 250 }
      } while ($els.Count -eq 0 -and (Get-Date) -lt $until)
      if ($els.Count -eq 0) { throw ('timed out after ' + $to + 's waiting for ' + (Describe-Sel $st)) }
      Write-Output ('found ' + (Fmt-El $els[0] $false))
    }
    'launch' {
      $app = [string]$st.app
      $base = [System.IO.Path]::GetFileNameWithoutExtension($app).ToLower()
      if ($ConsoleProcs -contains $base) { throw ('refused: ' + $app + ' is a terminal or shell. Use bash.') }
      $p = $null
      if ($st.args) { $p = Start-Process -FilePath $app -ArgumentList ([string]$st.args) -PassThru } else { $p = Start-Process -FilePath $app -PassThru }
      $to = 10
      if ($null -ne $st.timeout_s) { $to = [double]$st.timeout_s }
      $until = (Get-Date).AddSeconds($to)
      $found = $null
      do {
        Start-Sleep -Milliseconds 300
        $wins = @(Get-Wins)
        $found = $wins | Where-Object { $_.Current.ProcessId -eq $p.Id } | Select-Object -First 1
        if (-not $found -and $st.window) {
          $pat = '*' + [System.Management.Automation.WildcardPattern]::Escape([string]$st.window) + '*'
          $found = $wins | Where-Object { $_.Current.Name -like $pat } | Select-Object -First 1
        }
        if (-not $found) { $found = $wins | Where-Object { (Proc-Name $_.Current.ProcessId).ToLower() -eq $base } | Select-Object -First 1 }
      } while (-not $found -and (Get-Date) -lt $until)
      if ($found) {
        Guard-Window $found
        Write-Output ('launched ' + $app + ' (pid ' + $p.Id + '): window "' + (Short $found.Current.Name 60) + '" ' + (Proc-Name $found.Current.ProcessId) + ' pid:' + $found.Current.ProcessId)
      } else { Write-Output ('launched ' + $app + ' (pid ' + $p.Id + '), no window after ' + $to + 's. Use wait or list_windows.') }
    }
    default { throw ('unknown action ' + [string]$st.action) }
  }
}

$i = 0
$stopped = $false
$all = @($job.steps)
foreach ($st in $all) {
  $i++
  $script:note = ''
  try {
    $lines = @(Run-Step $st)
    $head = [string]$i + '. ' + $st.action + ' ok'
    if ($lines.Count -eq 1) { Write-Output ($head + ': ' + $lines[0]) }
    else { Write-Output $head; foreach ($l in $lines) { Write-Output ('   ' + $l) } }
  } catch {
    Write-Output ([string]$i + '. ' + $st.action + ' FAILED: ' + (Short $_.Exception.Message 400))
    if ($job.stopOnError) { $stopped = $true; break }
  }
}
if ($stopped -and $i -lt $all.Count) { Write-Output ('steps ' + ($i + 1) + '-' + $all.Count + ' skipped') }
if ($job.shot) {
  try { Shot-Win (Find-Win $job.shotWindow) } catch { Write-Output ('screenshot failed: ' + (Short $_.Exception.Message 200)) }
}
Write-Output 'DAEBOT_DONE'
if ($script:pending) { [Console]::Out.Flush(); [Environment]::Exit(0) }
`;

const PS_HEAD = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms, System.Drawing
Add-Type -Namespace Daebot -Name Cap -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RC { public int L; public int T; public int R; public int B; }
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
'@
`;

/** The whole script for a list of steps. The steps are JSON data in a single-quoted here-string. */
export function buildAppScript(steps: AppStep[], opts: { shot?: boolean; stopOnError?: boolean } = {}): string {
  const job = JSON.stringify({ steps, shot: opts.shot === true, shotWindow: lastWindow(steps) ?? null, stopOnError: opts.stopOnError !== false });
  // JSON.stringify never emits a raw newline, so the closing '@ can never appear at a line start inside the data.
  return `${PS_HEAD}${CONSOLE_CHECK_PS}\n$job = ConvertFrom-Json @'\n${job}\n'@\n${PS_BODY}`;
}

export interface AppOutput { text: string; blocked?: string; done: boolean; shot?: { width: number; height: number; jpegBase64: string } }
export function parseAppOutput(stdout: string): AppOutput {
  const lines = stdout.split(/\r?\n/);
  const blocked = parseBlocked(stdout);
  const keep: string[] = [];
  let shot: AppOutput["shot"];
  let done = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /^DAEBOT_APPSHOT (\d+) (\d+)\s*$/.exec(l);
    if (m) {
      const b64 = (lines[i + 1] ?? "").trim();
      if (/^[A-Za-z0-9+/=]+$/.test(b64)) shot = { width: Number(m[1]), height: Number(m[2]), jpegBase64: b64 };
      i++;
      continue;
    }
    if (l.startsWith("DAEBOT_BLOCKED ")) continue;
    if (l.trim() === "DAEBOT_DONE") { done = true; continue; }
    keep.push(l);
  }
  return { text: keep.join("\n").trim(), blocked, done, shot };
}

export function appToolSupported(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.DAEBOT_APP_CONTROL === "0" || env.DAEBOT_APP_CONTROL === "false") return false;
  return platform === "win32";
}

const STEP_PROPS = {
  action: { type: "string", enum: [...ACTIONS], description: "What to do. list_windows | tree | find | invoke (click a button or menu item) | set_value (fill a text field) | get_text | select | toggle | expand | collapse | launch | close | wait" },
  window: { type: "string", description: "Which window: part of its title, the process name, or pid:123. Carried to the next steps if they leave it out." },
  name: { type: "string", description: "The control's visible name (case-insensitive; contains unless exact:true)" },
  type: { type: "string", description: "UI Automation control type: Button, Edit, MenuItem, CheckBox, RadioButton, ComboBox, ListItem, TabItem, Document, Hyperlink, ..." },
  id: { type: "string", description: "The control's AutomationId (exact), as shown by tree or find" },
  exact: { type: "boolean" },
  index: { type: "number", description: "Which match to use when several controls match (default 0)" },
  value: { type: "string", description: "set_value: the text to put in the field" },
  depth: { type: "number", description: "tree: how many levels below the window (default 3, max 8)" },
  all: { type: "boolean", description: "tree: include off-screen controls" },
  max: { type: "number", description: "get_text: max characters (default 4000)" },
  state: { type: "string", enum: ["on", "off"], description: "toggle: set it to this state instead of flipping" },
  add: { type: "boolean", description: "select: add to the selection instead of replacing it" },
  app: { type: "string", description: "launch: program name or path" },
  args: { type: "string", description: "launch: arguments" },
  timeout_s: { type: "number", description: "wait/launch: seconds to wait (default 5 / 10, max 30)" },
} as const;

export function createAppTool(run?: ScriptRunner): Tool {
  return {
    class: "write",
    receipt: "surface",
    classFor(args): ToolClass {
      const list = Array.isArray(args.steps) ? (args.steps as Array<Record<string, unknown>>) : [args];
      return list.length > 0 && list.every((s) => READ_ACTIONS.has(s?.action as AppAction)) ? "read" : "write";
    },
    spec: {
      name: "app",
      description:
        "Operate a desktop app IN THE BACKGROUND with UI Automation (Windows). It does not move the mouse, press keys, take focus or take a screenshot unless you ask, so the user keeps using their PC. Use it BEFORE the `computer` tool for any desktop app: " +
        "click a button or menu item (invoke), fill a field (set_value), read text (get_text), pick a list/tab item (select), flip a checkbox (toggle), open/close a dropdown (expand/collapse), start the app (launch), close a window (close), wait for a control (wait). " +
        "Workflow: list_windows -> tree (see the control names, types, ids; {i v t s e x} after a control = it supports invoke, value, toggle, select, expand, text) -> act. " +
        "BATCH: put every step you can predict in ONE call as steps:[{action,...},...]; they run in one process and come back as one short text result. Steps stop at the first failure unless continue_on_error:true. " +
        "Add screenshot:true only if you need to SEE the last step's window (a picture of just that window, even when it is behind others). " +
        "It cannot open a terminal, PowerShell, cmd or the Run box: run commands with bash instead. If a control shows no patterns, or the app is drawn on a canvas, fall back to `computer`.",
      parameters: {
        type: "object",
        properties: {
          ...STEP_PROPS,
          steps: { type: "array", maxItems: MAX_STEPS, items: { type: "object", properties: STEP_PROPS, required: ["action"] }, description: "A batch of steps to run in order in one call." },
          screenshot: { type: "boolean", description: "Also return a screenshot of the last step's window. Default false." },
          continue_on_error: { type: "boolean", description: "Keep going after a failed step. Default false." },
        },
      },
    },
    async run(args, ctx): Promise<ToolResult> {
      const n = normalizeSteps(args);
      if ("error" in n) return fail(`app: ${n.error}`);
      if (n.shot && !lastWindow(n.steps)) return fail("app: screenshot needs a window");
      if (ctx.signal?.aborted) return fail("app: aborted before start");
      const script = buildAppScript(n.steps, { shot: n.shot, stopOnError: n.stopOnError });
      const runner = run ?? makeRunner(Math.min(180_000, SCRIPT_TIMEOUT_MS + n.steps.length * 3000), { mta: true });
      const r = await runner(script, ctx.signal);
      const o = parseAppOutput(r.stdout);
      if (o.blocked) return fail(`${blockedMessage("app", o.blocked)}${o.text ? ` Done before it:\n${o.text}` : ""}`);
      if (r.code !== 0 && !o.done) {
        const why = (r.stderr || o.text).replace(/\s+/g, " ").trim().slice(0, 500) || `exit code ${r.code}`;
        return fail(`app: failed: ${why}`);
      }
      const failed = /^\d+\. \w+ FAILED:/m.test(o.text);
      const text = o.text || "(no output)";
      return { ok: !failed, output: text, images: o.shot ? [`data:image/jpeg;base64,${o.shot.jpegBase64}`] : undefined, meta: { steps: n.steps.length } };
    },
  };
}
