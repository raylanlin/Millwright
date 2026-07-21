# SW Agent Sidecar

A long-running Python process that exposes a **structured** set of SolidWorks tools to the Electron main process / LLM agent over stdio JSON-RPC.

## Why this design (vs. the old cscript/VBS path)

| Dimension | Old: generate VBA → translate to VBS → cscript | New: Python sidecar |
|---|---|---|
| Process | A new cscript per call; stateless | Long-running, holds the COM pointer, can run multi-step transactions |
| Return | MsgBox popups; no structured data | `{"ok":true,"data":{...}}` JSON — the agent can observe and self-correct |
| Parameters | 27 positional args; one wrong slot silently returns null | Named parameters + wrapper functions |
| Language pitfalls | VBScript reserved words / regex translation | No translation layer |
| Vision | None | Built-in screenshot → image returned to the multimodal model |
| Source of truth | sw-tools.ts / generators / schema — three places | Sidecar `list_tools()` is the single source of truth |

## Running

```bash
# Dependencies (on the Windows host where SolidWorks runs)
pip install pywin32 pillow

# Manual smoke test (SolidWorks must already be open)
python -m sw_agent            # enters the JSON-RPC loop, reads stdin / writes stdout
```

The Electron main process spawns it via `sw-sidecar.ts`; you don't need to launch it manually.

## Protocol (stdio, line-delimited JSON)

Request: `{"id":1,"method":"list_tools"}`
         `{"id":2,"method":"call","params":{"name":"extrude","args":{"depth_mm":20}}}`
         `{"id":3,"method":"ping"}`

Response: `{"id":1,"ok":true,"data":[<tool schema>...]}`
          `{"id":2,"ok":false,"error":"no document is open"}`

## Layout

```
sw_agent/
├── __main__.py     enters the server loop
├── server.py       stdio JSON-RPC dispatcher
├── registry.py     @tool decorator + self-describing schema + call dispatch
├── bridge.py       COM connection (GetActiveObject, never CreateObject)
├── units.py        mm→m / deg→rad
└── tools/
    ├── view.py     view orientation / rotate / zoom / display mode + capture screenshot
    ├── document.py new / open / save / material / rebuild / properties / configurations
    ├── sketch.py   enter sketch + rectangle / circle / line / arc / polygon / fillet / relations / dimensions
    ├── feature.py  extrude / cut / revolve / fillet / chamfer (fixed) / shell / hole / pattern / mirror
    ├── reference.py reference planes / axes / points
    ├── assembly.py insert / mate / pattern / mirror / suppress / move
    ├── export.py   STEP / PDF / STL / DXF
    └── query.py    mass properties / interference / measure / bounding box / list features / list components
```

## ⚠ Calls that need verification against the target SolidWorks version

A handful of multi-argument feature APIs (sweep / loft / rib / draft / some slots of circular_pattern) may differ across SolidWorks versions.
Each of those functions carries a `# VERIFY:` comment in `feature.py` — verify and remove the comment once confirmed. Named-argument calls are far safer than positional VBS, but real testing is still recommended.