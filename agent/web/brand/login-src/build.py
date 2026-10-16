import base64, io, re
from PIL import Image

def b64(im, fmt="PNG", **kw):
    buf = io.BytesIO(); im.save(buf, fmt, optimize=True, **kw)
    return base64.b64encode(buf.getvalue()).decode()

mind = Image.open('brand/mind-logo-white.png').convert('RGBA')
mind = mind.resize((420, int(mind.height * 420 / mind.width)), Image.LANCZOS)
mind_b64 = b64(mind)
tile = Image.open('brand/icon-512.png').resize((112, 112), Image.LANCZOS)
tile_b64 = b64(tile)
mk = Image.open('brand/m-mark.png').convert('RGBA').resize((420, 420), Image.LANCZOS)
mk_b64 = b64(mk.quantize(colors=48, method=Image.FASTOCTREE, dither=Image.NONE))
print('mind', len(mind_b64), mind.size)

# favicon.svg: wraps the real M tile PNG (public path in hosted mode, so no external refs)
tile = Image.open('brand/icon-512.png').resize((96, 96), Image.LANCZOS)
open('favicon.svg', 'w').write('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><image width="96" height="96" href="data:image/png;base64,%s"/></svg>' % b64(tile))
fav = b64(Image.open('brand/favicon-32.png'))

wm = open('brand/daebot-wordmark.svg').read()
wm = wm.replace('<svg ', '<svg class="wordmark" role="img" aria-label="Daebot" ')

html = open('brand/login-src/login.html.tpl').read()
html = html.replace('__WORDMARK__', wm).replace('__FAV__', fav)
open('login.html', 'w').write(html)
css = open('brand/login-src/login.css.tpl').read()
css = css.replace('__MIND__', mind_b64).replace('__TILE__', tile_b64).replace('__MGHOST__', mk_b64).replace('__FLAME__', b64(Image.open('brand/mind-flame.png')))
open('login.css', 'w').write(css)
