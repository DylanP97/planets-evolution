#!/usr/bin/env python3
"""Launch the standalone asset-library dev scene on its own port.

The asset library lives in assets/dev/ but references the GLB models in assets/
(one level up), so the static server's root has to be the PROJECT ROOT — not
assets/dev/. This launcher handles that for you: it serves the project root on a
separate port and opens the browser straight to the library.

Your main app on port 8000 (python -m http.server 8000) is left untouched.

    python assets/dev/serve.py          # serves on 8001, opens the library
    python assets/dev/serve.py 9000     # pick another port

Stop it with Ctrl+C.
"""
import http.server
import os
import sys
import webbrowser
from functools import partial

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8001
# assets/dev/serve.py -> project root is two levels up.
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir, os.pardir))
URL = f"http://localhost:{PORT}/assets/dev/"


# Tell the browser never to cache: ES modules cache aggressively, so without this
# a plain reload serves a stale dev-scene.js while showing fresh HTML — edits
# look like they "don't apply" (e.g. a new button renders but its handler is old).
class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()


Handler = partial(NoCacheHandler, directory=ROOT)
print(f"Asset library  ->  {URL}")
print(f"Serving root   :  {ROOT}")
print("Ctrl+C to stop.")
try:
    webbrowser.open(URL)
except Exception:
    pass
http.server.ThreadingHTTPServer(("", PORT), Handler).serve_forever()
