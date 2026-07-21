# Pre-Public VERIFY Checklist

> **Purpose**: Track all `# VERIFY` markers in the Python sidecar that need SolidWorks macro-recorder validation against target SW versions before claiming full API coverage. **Until each item is verified, the corresponding feature is marked experimental** in the public README.
>
> **Process**: For each item below, file a GitHub issue (label: `verify`, `pre-public`) using the suggested title. Link it back here.

## Status legend

- [ ] = Open (needs SW macro validation)
- [x] = Verified and signed off
- ❌ = Won't fix / won't support (mark experimental in README)

---

## feature.py

| Tool | Line | Suggested issue title | Notes |
|------|------|----------------------|-------|
| `extrude` (FeatureExtrusion3) | 39 | verify: FeatureExtrusion3 24-param signature | Verify parameter positions vs target SW version |
| `cut` (FeatureCut4) | 61 | verify: FeatureCut4 25-param signature | Verify parameter positions |
| `revolve` (FeatureRevolve2) | 80 | verify: FeatureRevolve2 signature | Verify parameter positions |
| `fillet` (FeatureFillet3) | 99 | verify: FeatureFillet3 signature | "不同版本略异" — verify on every supported version |
| `linear_pattern` (Type 枚举) | 139 | verify: linear pattern Type enum (1=距离-距离) | Verify enum value mapping |
| `shell` (InsertShell) | 156 | verify: InsertShell ownership/signature | Verify whether it's `IModelDoc2::InsertShell(thickness, outward)` |
| `linear_pattern` (FeatureLinearPattern5) | 174 | verify: FeatureLinearPattern5 param positions | Verify parameter positions |
| `circular_pattern` (FeatureCircularPattern5) | 196 | verify: FeatureCircularPattern5 param positions | Verify parameter positions |
| `mirror_feature` (InsertMirrorFeature2) | 215 | verify: InsertMirrorFeature2 signature | Verify parameter positions |

## export.py

| Tool | Line | Suggested issue title | Notes |
|------|------|----------------------|-------|
| `export_stl` | 13 | verify: STL export quality enum (334 = 精细?) | "粗糙=0 精细=1" — verify enum mapping on target SW |

## Already verified (no issue needed)

These were already validated during P3 integration:

- `mate` enum + `AddMate5` signature (assembly.py)
- Document type / template constants
- Sketch primitive constants
- `chamfer` parameter roles (chamfer bug fixed in feature.py)

## Verification procedure

For each item:

1. Open target SolidWorks version with a sample document
2. Start macro recorder (Tools → Macro → Record)
3. Perform the operation through the UI with non-default parameters
4. Stop macro, inspect the recorded VBA
5. Compare parameter order with the Python implementation in feature.py / export.py
6. If mismatched: file a follow-up issue and patch the Python
7. Update this doc: `[ ]` → `[x]` with SW version + date

## README disclaimer template

Until all items are `[x]`, the public README must state:

> **Experimental APIs**: Several SolidWorks feature APIs in `sidecar/sw_agent/tools/feature.py` and `export.py` rely on parameter-position orderings that may differ across SolidWorks versions. These are marked `# VERIFY` in source. If a feature returns an error or unexpected geometry, please file an issue with your SW version and a minimal repro.
