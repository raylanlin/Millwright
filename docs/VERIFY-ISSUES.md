# Verification backlog — multi-parameter SolidWorks APIs

Some SolidWorks feature APIs take long positional argument lists whose exact
parameter positions and enum values can differ between SolidWorks releases.
The sidecar calls them by name (safer than the old positional VBScript), but the
argument positions still deserve a one-time check against a target SolidWorks
version using the **macro recorder** (record the operation in SolidWorks, then
compare the generated call to ours).

Each item below is ready to file as a GitHub issue. Remove the `# VERIFY:`
comment in the source once confirmed on a given version.

| # | Tool | Source | API call | What to verify |
|---|------|--------|----------|----------------|
| 1 | `extrude` | `sidecar/sw_agent/tools/feature.py` | `FeatureExtrusion3` | 24-arg positions (end conditions, draft, merge flags) |
| 2 | `cut_extrude` | feature.py | `FeatureCut4` | 25-arg positions; through-all flag |
| 3 | `revolve` | feature.py | `FeatureRevolve2` | arg positions; thin-feature flags |
| 4 | `fillet_edges` | feature.py | `FeatureFillet3` | fillet-type constant (195) + arg positions |
| 5 | `shell` | feature.py | `InsertShell` | method ownership & signature `(thickness, outward)` |
| 6 | `linear_pattern` | feature.py | `FeatureLinearPattern5` | arg positions; direction refs |
| 7 | `circular_pattern` | feature.py | `FeatureCircularPattern5` | arg positions; equal-spacing flag |
| 8 | `mirror_feature` | feature.py | `InsertMirrorFeature2` | arg positions |
| 9 | `create_reference_point` | `sidecar/sw_agent/tools/reference.py` | `InsertReferencePoint` | reference-point type enum + arg positions |
| 10 | `export_stl` | `sidecar/sw_agent/tools/export.py` | `SetUserPreferenceIntegerValue(334, …)` | STL-quality preference constant (334) |

## Already verified (no action)
- `add_mate` — `swMateType_e` enum + `AddMate5` 15-arg signature
- document type / template constants
- sketch primitives (`CreateCornerRectangle`, `CreateCircle`, `CreateLine`, `CreateArc`, `CreatePolygon`)
- `chamfer` — parameter roles corrected (distance in Width slot, not Angle)

## Issue template

```
Title: [VERIFY] <tool> — confirm <API> parameter positions on SolidWorks <version>

Tool: <tool>  (sidecar/sw_agent/tools/<file>.py)
API: <API call>
SolidWorks version tested: <e.g. 2021 SP5>

Steps:
1. Record the equivalent operation with the SolidWorks macro recorder.
2. Compare the recorded call's argument order/values to ours.
3. Report matches/mismatches; attach the recorded snippet.

Definition of done: `# VERIFY:` comment removed for this API on a confirmed version.
```
