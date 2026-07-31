// src/main/scripts/macro-lint.ts
//
// P58: static checks for agent-written VBA/VBScript macros.
//
// Models write fluent SolidWorks macros — training data is full of them — but fluency
// is not correctness, and VBA is a language where being wrong does not raise. The
// failures we saw in real generated macros were always the same four:
//
//   1. Millimetres passed straight to a metric API. `FeatureExtrusion2(..., 40, ...)`
//      means FORTY METRES. The macro "succeeds" and produces nonsense.
//   2. `On Error Resume Next` at the top, so every subsequent failure is silent and
//      the macro reports success having done nothing.
//   3. Invented entity names — "PinionShaft-1@Assem1/圆柱面" — SelectByID2 returns
//      False, nothing is selected, the next call quietly no-ops.
//   4. Hard-coded API arity (`FeatureCut3` with exactly 25 args), which 400s on a
//      SolidWorks whose signature has one more optional parameter.
//
// These are ERRORS or WARNINGS, not a security matter — sanitizer.ts still runs
// separately for that. Errors block execution; warnings ride along in the result so
// the model learns what to fix.

export interface MacroLintIssue {
  severity: 'error' | 'warning';
  line: number;
  message: string;
}

export interface MacroLintResult {
  ok: boolean;
  issues: MacroLintIssue[];
}

/** Metric SolidWorks APIs whose numeric arguments are METRES / RADIANS, not mm / degrees. */
const METRIC_APIS = [
  'FeatureExtrusion', 'FeatureCut', 'FeatureRevolve', 'FeatureFillet', 'FeatureChamfer',
  'InsertFeatureShell', 'InsertShell', 'InsertRefPlane', 'CreateCornerRectangle',
  'CreateCenterRectangle', 'CreateCircle', 'CreateLine', 'CreateCenterLine', 'CreateArc',
  'CreatePolygon', 'AddComponent', 'AddMate', 'SetSystemValue', 'SetDepth',
  'FeatureLinearPattern', 'FeatureCircularPattern', 'CreateFillet',
];

/** A literal this large can only be a mm value fed to a metre API (1 m = a metre-wide part). */
const SUSPICIOUS_MM = 1.0;

/**
 * P79: a length that big is not a length at all — it is an option bitmask.
 *
 * The check used to flag EVERY large literal near a metric API, so
 * FeatureFillet3(196609, 0.01, …) was rejected for "passing 196609 millimetres" when
 * 196609 is swFilletFeature flags and 0.01 is the actual radius. The model wrote correct
 * code twice and was refused both times, which is worse than not checking: it teaches the
 * model to distrust a guard that is usually right.
 *
 * 10 metres is already an implausible dimension for a SolidWorks part, and every real
 * mm-for-metres slip we have seen was a plain part dimension (40, 80, 194…). Anything
 * beyond this is left alone.
 */
const IMPLAUSIBLE_AS_MM = 10_000;

/** Argument positions that are flags/enums rather than lengths, per API. */
const FLAG_ARGS: Record<string, number[]> = {
  FeatureFillet: [0],        // options bitmask
  FeatureChamfer: [0],
  FeatureExtrusion: [0, 1, 2, 3, 4],   // Sd, Flip, Dir, T1, T2 — lengths start at D1
  FeatureCut: [0, 1, 2, 3, 4],
  FeatureRevolve: [0],
  InsertRefPlane: [0, 2, 4],  // constraint types interleave with values
  SetSystemValue: [],
};

function stripStrings(line: string): string {
  return line.replace(/"(?:[^"]|"")*"/g, '""');
}

export function lintMacro(code: string): MacroLintResult {
  const issues: MacroLintIssue[] = [];
  const lines = (code ?? '').split(/\r?\n/);

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = stripStrings(raw);
    if (/^\s*'/.test(line)) return; // comment

    // 1. Silent-failure mode
    if (/\bOn\s+Error\s+Resume\s+Next\b/i.test(line)) {
      issues.push({
        severity: 'error',
        line: n,
        message: 'On Error Resume Next 会让后续每一步失败都静默通过 —— 宏"执行成功"但什么也没做。'
          + '删掉它；本工具会把真实异常和出错行号回报给你。',
      });
    }

    // 2. mm passed to a metric API
    for (const api of METRIC_APIS) {
      const re = new RegExp(`\\b${api}\\d*\\s*\\(([^)]*)\\)`, 'i');
      const m = re.exec(line);
      if (!m) continue;
      const flagPositions = FLAG_ARGS[api] ?? [];
      const bad = m[1]
        .split(',')
        .map((a, idx) => ({ a: a.trim(), idx }))
        // P79: skip the argument slots that carry flags/enums rather than lengths
        .filter(({ idx }) => !flagPositions.includes(idx))
        .filter(({ a }) => /^-?\d+(\.\d+)?$/.test(a))
        .map(({ a }) => a)
        .filter((a) => {
          const v = Math.abs(parseFloat(a));
          return v > SUSPICIOUS_MM && v < IMPLAUSIBLE_AS_MM;
        });
      if (bad.length) {
        issues.push({
          severity: 'error',
          line: n,
          message: `${api} 的长度参数单位是【米】，这里出现了 ${bad.slice(0, 3).join(', ')} —— `
            + `看起来是毫米值直接传进去了（意味着 ${bad[0]} 米）。请写成 ${bad[0]}/1000 或 ${bad[0]} * 0.001。`,
        });
        break;
      }
    }

    // 3. Invented entity names — the classic assembly-path guess
    const sel = /SelectByID2?\s*\(\s*"([^"]*)"/i.exec(raw);
    if (sel && /@/.test(sel[1]) && /面|Face|Edge|边/i.test(sel[1])) {
      issues.push({
        severity: 'warning',
        line: n,
        message: `"${sel[1]}" 这类带 @ 的面/边名几乎不可能猜对，SelectByID2 会返回 False 而后续调用静默空转。`
          + '改用 list_features / list_components 拿到真实名字，或改用现成工具（它们按语义选面选边）。',
      });
    }

    // 4. Return values never checked
    if (/\bSet\s+\w+\s*=\s*\w*(FeatureExtrusion|FeatureCut|FeatureRevolve)\d*\s*\(/i.test(line)) {
      // fine — the result is captured; we only warn on the bare-call form below
    } else if (/^\s*\w*\.(FeatureExtrusion|FeatureCut|FeatureRevolve)\d*\s*\(/i.test(line)) {
      issues.push({
        severity: 'warning',
        line: n,
        message: '特征创建的返回值没有接收，失败时无法察觉。写成 Set f = ... 并检查 If f Is Nothing。',
      });
    }
  });

  // 5. Hard-coded arity on the APIs known to drift between releases
  if (/\bFeatureCut[34]?\s*\(/i.test(code) || /\bFeatureExtrusion[23]?\s*\(/i.test(code)) {
    issues.push({
      severity: 'warning',
      line: 0,
      message: 'FeatureCut / FeatureExtrusion 的参数个数在不同 SolidWorks 版本间会变（同一方法 25/26/27 个参数都存在），'
        + '写死一个个数在别的机器上会直接 400。这类操作优先用 extrude / cut_extrude 工具 —— 它们会自动搜索本机可用的参数个数。',
    });
  }

  return { ok: !issues.some((x) => x.severity === 'error'), issues };
}

/** Render issues for the model: grouped, line-numbered, actionable. */
export function formatLintIssues(issues: MacroLintIssue[]): string {
  if (!issues.length) return '';
  const fmt = (x: MacroLintIssue) =>
    `${x.severity === 'error' ? '✖' : '⚠'} ${x.line ? `第 ${x.line} 行` : '整体'}：${x.message}`;
  return issues.map(fmt).join('\n');
}
