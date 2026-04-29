import { useState, useRef, useEffect, useCallback } from "react";

const THEMES = {
  light: {
    bg: "#f3f4f6", sidebar: "#e9eaed", sidebarBorder: "#d4d5d9",
    card: "#ffffff", cardBorder: "#dcdde1", cardAlt: "#f0f0f3",
    inputBg: "#ffffff", inputBorder: "#ccced3",
    text: "#1f2937", textSecondary: "#5f6672", textMuted: "#8b8f98",
    accent: "#3b3f4a", accentSoft: "#e8e9ed", accentText: "#3b3f4a",
    userBubble: "#3b3f4a", userBubbleText: "#ffffff",
    aiBubble: "#ffffff", aiBubbleBorder: "#dcdde1",
    codeBg: "#f5f5f8", codeBorder: "#e0e1e5", codeText: "#2d6a4f",
    toolBg: "#edeef2", toolBorder: "#d4d5d9", toolText: "#4a4e59",
    btnPrimary: "#3b3f4a", btnPrimaryText: "#ffffff",
    btnSecondary: "#e8e9ed", btnSecondaryText: "#4a4e59", btnSecondaryBorder: "#d4d5d9",
    statusBarBg: "#edeef2",
    modalOverlay: "rgba(100,100,110,0.35)", modalBg: "#ffffff",
    scrollThumb: "#c8c9ce", scrollHover: "#a8a9ae",
    selectBg: "#ffffff", placeholder: "#aeb2ba",
    dot: "#3b3f4a",
  },
  dark: {
    bg: "#1b1c20", sidebar: "#232428", sidebarBorder: "#313238",
    card: "#27282e", cardBorder: "#37383f", cardAlt: "#222328",
    inputBg: "#1e1f24", inputBorder: "#37383f",
    text: "#d5d6da", textSecondary: "#8e9099", textMuted: "#5e6068",
    accent: "#8a8d96", accentSoft: "#2e2f35", accentText: "#c5c7ce",
    userBubble: "#47494f", userBubbleText: "#e8e9ed",
    aiBubble: "#27282e", aiBubbleBorder: "#37383f",
    codeBg: "#1e1f24", codeBorder: "#313238", codeText: "#7ec8a0",
    toolBg: "#2a2b31", toolBorder: "#37383f", toolText: "#9a9ca5",
    btnPrimary: "#505259", btnPrimaryText: "#e8e9ed",
    btnSecondary: "#2e2f35", btnSecondaryText: "#9a9ca5", btnSecondaryBorder: "#3a3b42",
    statusBarBg: "#222328",
    modalOverlay: "rgba(0,0,0,0.55)", modalBg: "#27282e",
    scrollThumb: "#3a3b42", scrollHover: "#4a4b52",
    selectBg: "#1e1f24", placeholder: "#4e5058",
    dot: "#8a8d96",
  },
};

const PRESETS = {
  anthropic: [
    { label: "Claude Sonnet 4", value: "claude-sonnet-4-20250514" },
    { label: "Claude Opus 4", value: "claude-opus-4-20250514" },
    { label: "Claude Haiku 3.5", value: "claude-3-5-haiku-20241022" },
    { label: "自定义模型", value: "custom" },
  ],
  openai: [
    { label: "GPT-4o", value: "gpt-4o" },
    { label: "GPT-4o Mini", value: "gpt-4o-mini" },
    { label: "GPT-4.1", value: "gpt-4.1" },
    { label: "自定义模型", value: "custom" },
  ],
};

const DEFAULT_URLS = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

const SAMPLE_AUTOMATIONS = [
  { icon: "⚙️", label: "批量修改圆角半径", desc: "选中装配体中所有零件，统一修改圆角" },
  { icon: "📐", label: "导出工程图 PDF", desc: "将当前零件的所有视图导出为 PDF" },
  { icon: "🔩", label: "插入标准件", desc: "从标准库中搜索并插入螺栓、螺母等" },
  { icon: "📦", label: "批量重命名零件", desc: "按规则批量重命名装配体中的零件" },
  { icon: "🔄", label: "镜像装配体", desc: "对当前装配体执行镜像操作" },
  { icon: "📊", label: "BOM 表导出", desc: "导出物料清单到 Excel" },
];

const SW_TOOLS = [
  "create_part", "create_sketch", "draw_rectangle", "draw_circle",
  "extrude_feature", "create_fillet", "create_chamfer", "create_revolve",
  "insert_component", "add_mate", "export_step", "export_pdf",
  "batch_rename", "modify_dimensions", "check_interference", "mass_properties"
];

function StatusDot({ connected }) {
  return (
    <span style={{
      display: "inline-block", width: 7, height: 7, borderRadius: "50%",
      background: connected ? "#4caf72" : "#d45454",
      boxShadow: connected ? "0 0 4px #4caf7266" : "0 0 4px #d4545466",
      marginRight: 6,
    }} />
  );
}

function SettingsPanel({ config, setConfig, onClose, swConnected, t, theme, setTheme }) {
  const [showKey, setShowKey] = useState(false);
  const [testStatus, setTestStatus] = useState(null);
  const [customModel, setCustomModel] = useState("");

  const handleProtocol = (p) => {
    setConfig(c => ({ ...c, protocol: p, baseURL: DEFAULT_URLS[p], model: PRESETS[p][0].value }));
    setTestStatus(null);
  };

  const handleTest = () => {
    setTestStatus("testing");
    setTimeout(() => {
      setTestStatus(config.apiKey && config.apiKey.length > 10 ? "success" : "error");
    }, 1500);
  };

  const labelStyle = { color: t.textSecondary, fontSize: 11, fontWeight: 600, marginBottom: 6, display: "block", letterSpacing: 0.5 };
  const fieldStyle = {
    width: "100%", padding: "10px 13px", borderRadius: 7,
    border: `1px solid ${t.inputBorder}`, background: t.inputBg, color: t.text,
    fontSize: 13, outline: "none", fontFamily: "'Consolas', 'SF Mono', monospace",
    boxSizing: "border-box",
  };

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 100,
      display: "flex", alignItems: "center", justifyContent: "center",
      background: t.modalOverlay, backdropFilter: "blur(6px)",
    }}>
      <div style={{
        width: 500, maxHeight: "88vh", overflow: "auto",
        background: t.modalBg, borderRadius: 14, border: `1px solid ${t.cardBorder}`,
        boxShadow: "0 20px 60px rgba(0,0,0,0.18)", padding: "28px 32px",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{ margin: 0, fontSize: 17, color: t.text, fontWeight: 600 }}>设置</h2>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: t.textMuted, fontSize: 20, cursor: "pointer", padding: "2px 6px",
          }}>✕</button>
        </div>

        {/* Theme */}
        <label style={labelStyle}>外观主题</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
          {[{ k: "light", l: "浅色" }, { k: "dark", l: "深色" }].map(({ k, l }) => (
            <button key={k} onClick={() => setTheme(k)} style={{
              flex: 1, padding: "9px 14px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 500,
              border: theme === k ? `2px solid ${t.accent}` : `1px solid ${t.inputBorder}`,
              background: theme === k ? t.accentSoft : t.cardAlt,
              color: theme === k ? t.text : t.textSecondary, transition: "all 0.15s",
            }}>{l}</button>
          ))}
        </div>

        {/* SW Status */}
        <div style={{
          background: t.cardAlt, borderRadius: 8, padding: "12px 16px", marginBottom: 20,
          border: `1px solid ${t.cardBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <span style={{ color: t.textSecondary, fontSize: 13 }}>SolidWorks 连接</span>
          <div style={{ display: "flex", alignItems: "center" }}>
            <StatusDot connected={swConnected} />
            <span style={{ color: swConnected ? "#4caf72" : "#d45454", fontSize: 12, fontWeight: 500 }}>
              {swConnected ? "已连接" : "未检测到"}
            </span>
          </div>
        </div>

        {/* Protocol */}
        <label style={labelStyle}>API 协议</label>
        <div style={{ display: "flex", gap: 8, marginBottom: 18 }}>
          {["anthropic", "openai"].map(p => (
            <button key={p} onClick={() => handleProtocol(p)} style={{
              flex: 1, padding: "10px 14px", borderRadius: 7, cursor: "pointer", fontSize: 13, fontWeight: 500,
              border: config.protocol === p ? `2px solid ${t.accent}` : `1px solid ${t.inputBorder}`,
              background: config.protocol === p ? t.accentSoft : t.cardAlt,
              color: config.protocol === p ? t.text : t.textSecondary, transition: "all 0.15s",
            }}>
              {p === "anthropic" ? "Anthropic" : "OpenAI 兼容"}
            </button>
          ))}
        </div>

        {/* Base URL */}
        <label style={labelStyle}>Base URL</label>
        <input value={config.baseURL} onChange={e => { setConfig(c => ({ ...c, baseURL: e.target.value })); setTestStatus(null); }}
          placeholder={DEFAULT_URLS[config.protocol]} style={{ ...fieldStyle, marginBottom: 4 }} />
        <p style={{ color: t.textMuted, fontSize: 11, margin: "2px 0 16px 1px" }}>
          百炼 / MiniMax / DeepSeek 等选「OpenAI 兼容」并填对应 URL
        </p>

        {/* API Key */}
        <label style={labelStyle}>API Key</label>
        <div style={{ position: "relative", marginBottom: 16 }}>
          <input type={showKey ? "text" : "password"} value={config.apiKey}
            onChange={e => { setConfig(c => ({ ...c, apiKey: e.target.value })); setTestStatus(null); }}
            placeholder={config.protocol === "anthropic" ? "sk-ant-..." : "sk-..."}
            style={{ ...fieldStyle, paddingRight: 40 }} />
          <button onClick={() => setShowKey(!showKey)} style={{
            position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)",
            background: "none", border: "none", color: t.textMuted, cursor: "pointer", fontSize: 14,
          }}>{showKey ? "🙈" : "👁️"}</button>
        </div>

        {/* Model */}
        <label style={labelStyle}>模型</label>
        <select value={config.model} onChange={e => setConfig(c => ({ ...c, model: e.target.value }))}
          style={{ ...fieldStyle, marginBottom: config.model === "custom" ? 8 : 16, cursor: "pointer", fontFamily: "'Segoe UI', sans-serif" }}>
          {PRESETS[config.protocol].map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        {config.model === "custom" && (
          <input value={customModel} onChange={e => setCustomModel(e.target.value)}
            placeholder="如 deepseek-chat, qwen-coder-plus" style={{ ...fieldStyle, marginBottom: 16 }} />
        )}

        {/* System Prompt */}
        <label style={labelStyle}>系统提示词 <span style={{ color: t.textMuted, fontWeight: 400 }}>（可选）</span></label>
        <textarea value={config.systemPrompt} onChange={e => setConfig(c => ({ ...c, systemPrompt: e.target.value }))}
          placeholder="你是一个 SolidWorks 自动化助手，精通 SolidWorks API..." rows={3}
          style={{ ...fieldStyle, fontFamily: "'Segoe UI', sans-serif", resize: "vertical", lineHeight: 1.5, marginBottom: 22 }} />

        {/* Actions */}
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={handleTest} disabled={testStatus === "testing"} style={{
            flex: 1, padding: "11px", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 500,
            border: `1px solid ${t.cardBorder}`, transition: "all 0.15s",
            background: testStatus === "success" ? "#e8f5ec" : testStatus === "error" ? "#fceaea" : t.cardAlt,
            color: testStatus === "success" ? "#2d7a4a" : testStatus === "error" ? "#c44040" : t.textSecondary,
          }}>
            {testStatus === "testing" ? "测试中..." : testStatus === "success" ? "✓ 连接成功" : testStatus === "error" ? "✕ 连接失败" : "测试连接"}
          </button>
          <button onClick={onClose} style={{
            flex: 1, padding: "11px", borderRadius: 8, border: "none", cursor: "pointer",
            background: t.btnPrimary, color: t.btnPrimaryText, fontSize: 13, fontWeight: 500,
          }}>保存</button>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ msg, t }) {
  const isUser = msg.role === "user";
  return (
    <div style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", marginBottom: 14, paddingLeft: isUser ? 60 : 0, paddingRight: isUser ? 0 : 60 }}>
      <div style={{
        maxWidth: "85%", padding: "11px 15px", borderRadius: 10,
        background: isUser ? t.userBubble : t.aiBubble,
        color: isUser ? t.userBubbleText : t.text,
        border: isUser ? "none" : `1px solid ${t.aiBubbleBorder}`,
        fontSize: 13, lineHeight: 1.65, whiteSpace: "pre-wrap",
      }}>
        {!isUser && msg.toolCalls && (
          <div style={{ background: t.codeBg, borderRadius: 6, padding: "7px 10px", marginBottom: 9, border: `1px solid ${t.codeBorder}` }}>
            <span style={{ color: t.textSecondary, fontSize: 11, fontWeight: 600 }}>调用工具：</span>
            <div style={{ marginTop: 3, display: "flex", flexWrap: "wrap", gap: 4 }}>
              {msg.toolCalls.map((tc, i) => (
                <span key={i} style={{
                  padding: "2px 7px", borderRadius: 4, background: t.toolBg, color: t.toolText,
                  fontSize: 11, fontFamily: "'Consolas', monospace", border: `1px solid ${t.toolBorder}`,
                }}>{tc}</span>
              ))}
            </div>
          </div>
        )}
        {msg.code && (
          <div style={{
            background: t.codeBg, borderRadius: 6, padding: "10px 12px", marginBottom: 9,
            border: `1px solid ${t.codeBorder}`, fontFamily: "'Consolas', monospace",
            fontSize: 11.5, color: t.codeText, overflowX: "auto", lineHeight: 1.6,
          }}>
            <div style={{ color: t.textMuted, fontSize: 10, marginBottom: 5 }}>VBA / Python</div>
            {msg.code}
          </div>
        )}
        {msg.content}
        {msg.status && (
          <div style={{
            marginTop: 7, padding: "5px 9px", borderRadius: 5, fontSize: 11.5,
            background: msg.status === "success" ? "#e8f5ec" : "#fceaea",
            color: msg.status === "success" ? "#2d7a4a" : "#c44040",
            display: "flex", alignItems: "center", gap: 5,
          }}>
            {msg.status === "success" ? "✓" : "✕"} {msg.statusText}
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState("light");
  const t = THEMES[theme];
  const [showSettings, setShowSettings] = useState(false);
  const [swConnected, setSwConnected] = useState(true);
  const [config, setConfig] = useState({
    protocol: "anthropic", baseURL: DEFAULT_URLS.anthropic, apiKey: "", model: "claude-sonnet-4-20250514", systemPrompt: "",
  });
  const [messages, setMessages] = useState([{
    role: "assistant",
    content: "你好，我是 SolidWorks AI 助手。\n\n我可以帮你用自然语言自动化 CAD 操作、批量修改参数、生成宏脚本、导出文件等。\n\n请先在设置中配置 API，然后告诉我你想做什么。",
  }]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState("chat");
  const chatEndRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const sendMessage = useCallback(() => {
    if (!input.trim() || isGenerating) return;
    setMessages(prev => [...prev, { role: "user", content: input.trim() }]);
    const q = input.toLowerCase();
    setInput("");
    setIsGenerating(true);

    setTimeout(() => {
      let response;
      if (!config.apiKey) {
        response = { role: "assistant", content: "请先在设置中配置 API Key。\n\n点击左下角「设置」按钮进行配置。" };
      } else if (q.includes("圆角") || q.includes("fillet")) {
        response = {
          role: "assistant", toolCalls: ["create_fillet", "modify_dimensions"],
          code: `Dim swApp As SldWorks.SldWorks\nDim swModel As ModelDoc2\nSet swApp = Application.SldWorks\nSet swModel = swApp.ActiveDoc\n\nDim swFeat As Feature\nSet swFeat = swModel.FirstFeature\nDo While Not swFeat Is Nothing\n  If swFeat.GetTypeName2 = "Fillet" Then\n    swFeat.Select2 False, 0\n    swFeat.SetParameter "Radius", 0.003\n  End If\n  Set swFeat = swFeat.GetNextFeature\nLoop`,
          content: "已生成批量修改圆角的脚本。检测到 8 个圆角特征，将统一改为 3mm。\n\n确认执行吗？",
          status: "success", statusText: "脚本已生成，等待确认",
        };
      } else if (q.includes("导出") || q.includes("export")) {
        response = {
          role: "assistant", toolCalls: ["export_step", "export_pdf"],
          code: `import win32com.client\nsw = win32com.client.Dispatch("SldWorks.Application")\nmodel = sw.ActiveDoc\nmodel.Extension.SaveAs("C:\\\\output\\\\part.step", 0, 0, None, None, None)\nmodel.Extension.SaveAs("C:\\\\output\\\\drawing.pdf", 0, 0, None, None, None)`,
          content: "已生成导出脚本，将当前文件导出为 STEP + PDF。", status: "success", statusText: "导出完成",
        };
      } else if (q.includes("螺栓") || q.includes("螺母") || q.includes("标准件")) {
        response = { role: "assistant", toolCalls: ["insert_component", "add_mate"],
          content: "需要插入哪种标准件？\n\n• M6×20 六角螺栓 (GB/T 5782)\n• M6 六角螺母 (GB/T 6170)\n• M6 弹簧垫圈 (GB/T 93)\n• M8×30 内六角螺栓 (GB/T 70.1)\n\n请告诉我规格和数量。" };
      } else {
        response = { role: "assistant", content: `收到："${input.trim()}"\n\n正在分析如何通过 SolidWorks API 实现。\n\n模型：${config.model}\n协议：${config.protocol}` };
      }
      setMessages(prev => [...prev, response]);
      setIsGenerating(false);
    }, 1200);
  }, [input, isGenerating, config]);

  const handleKeyDown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } };
  const isConfigured = config.apiKey && config.apiKey.length > 5;

  return (
    <div style={{ width: "100%", height: "100vh", display: "flex", background: t.bg, color: t.text, fontFamily: "'Segoe UI', -apple-system, sans-serif", overflow: "hidden", transition: "background 0.25s, color 0.25s" }}>

      {/* Sidebar */}
      <div style={{ width: 240, background: t.sidebar, borderRight: `1px solid ${t.sidebarBorder}`, display: "flex", flexDirection: "column", flexShrink: 0, transition: "background 0.25s" }}>
        <div style={{ padding: "18px 16px 14px", borderBottom: `1px solid ${t.sidebarBorder}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{
              width: 30, height: 30, borderRadius: 7, background: t.btnPrimary,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 14, fontWeight: 700, color: t.btnPrimaryText,
            }}>S</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: t.text }}>SW Copilot</div>
              <div style={{ fontSize: 10, color: t.textMuted }}>SolidWorks AI 助手</div>
            </div>
          </div>
        </div>

        <div style={{ padding: "10px 16px", borderBottom: `1px solid ${t.sidebarBorder}` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center" }}><StatusDot connected={swConnected} /><span style={{ fontSize: 11, color: t.textSecondary }}>SolidWorks</span></div>
            <button onClick={() => setSwConnected(!swConnected)} style={{ background: "none", border: "none", color: t.textMuted, fontSize: 10, cursor: "pointer" }}>刷新</button>
          </div>
          <div style={{ display: "flex", alignItems: "center" }}>
            <StatusDot connected={isConfigured} />
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {isConfigured ? `${config.protocol} · ${config.model.split("-").slice(0, 2).join("-")}` : "API 未配置"}
            </span>
          </div>
        </div>

        <div style={{ padding: "10px 10px 0" }}>
          {[{ key: "chat", icon: "💬", label: "对话" }, { key: "automations", icon: "⚡", label: "自动化" }, { key: "tools", icon: "🔧", label: "工具列表" }].map(tab => (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)} style={{
              width: "100%", padding: "9px 12px", borderRadius: 7, border: "none", cursor: "pointer", textAlign: "left",
              background: activeTab === tab.key ? t.accentSoft : "transparent",
              color: activeTab === tab.key ? t.text : t.textSecondary,
              fontSize: 13, fontWeight: activeTab === tab.key ? 600 : 400, marginBottom: 1,
              display: "flex", alignItems: "center", gap: 9, transition: "all 0.12s",
            }}><span style={{ fontSize: 14 }}>{tab.icon}</span>{tab.label}</button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <div style={{ padding: "8px 10px 14px", borderTop: `1px solid ${t.sidebarBorder}` }}>
          <button onClick={() => setTheme(theme === "light" ? "dark" : "light")} style={{
            width: "100%", padding: "8px 12px", borderRadius: 7, marginBottom: 6,
            border: `1px solid ${t.cardBorder}`, cursor: "pointer",
            background: t.cardAlt, color: t.textSecondary, fontSize: 12,
            display: "flex", alignItems: "center", gap: 7, transition: "all 0.12s",
          }}>{theme === "light" ? "🌙" : "☀️"} {theme === "light" ? "深色模式" : "浅色模式"}</button>
          <button onClick={() => setShowSettings(true)} style={{
            width: "100%", padding: "8px 12px", borderRadius: 7,
            border: `1px solid ${t.cardBorder}`, cursor: "pointer",
            background: t.cardAlt, color: t.textSecondary, fontSize: 12,
            display: "flex", alignItems: "center", gap: 7, transition: "all 0.12s",
          }}>⚙️ 设置</button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div style={{ height: 48, borderBottom: `1px solid ${t.sidebarBorder}`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 18px", flexShrink: 0 }}>
          <span style={{ fontSize: 13, color: t.textSecondary, fontWeight: 500 }}>
            {activeTab === "chat" ? "💬 对话" : activeTab === "automations" ? "⚡ 快捷自动化" : "🔧 可用工具"}
          </span>
          {activeTab === "chat" && (
            <button onClick={() => setMessages([messages[0]])} style={{
              background: "none", border: `1px solid ${t.cardBorder}`, color: t.textMuted,
              padding: "4px 10px", borderRadius: 5, cursor: "pointer", fontSize: 11,
            }}>清空对话</button>
          )}
        </div>

        {activeTab === "chat" ? (
          <>
            <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
              {messages.map((msg, i) => <ChatMessage key={i} msg={msg} t={t} />)}
              {isGenerating && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 14px", color: t.textMuted, fontSize: 13 }}>
                  <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: t.dot, animation: "pulse 1.4s infinite" }} />
                  正在思考...
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div style={{ padding: "14px 18px", borderTop: `1px solid ${t.sidebarBorder}`, flexShrink: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", background: t.card, borderRadius: 10, border: `1px solid ${t.cardBorder}`, padding: "3px 3px 3px 14px" }}>
                <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
                  placeholder="描述你想在 SolidWorks 中执行的操作..." rows={1}
                  style={{ flex: 1, background: "none", border: "none", color: t.text, fontSize: 13, outline: "none", resize: "none", padding: "9px 0", lineHeight: 1.5 }} />
                <button onClick={sendMessage} disabled={!input.trim() || isGenerating} style={{
                  width: 36, height: 36, borderRadius: 8, border: "none",
                  background: input.trim() ? t.btnPrimary : t.cardAlt,
                  color: input.trim() ? t.btnPrimaryText : t.textMuted,
                  cursor: input.trim() ? "pointer" : "default", fontSize: 16,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  transition: "all 0.15s", flexShrink: 0,
                }}>↑</button>
              </div>
              <div style={{ textAlign: "center", marginTop: 6, fontSize: 10, color: t.textMuted }}>
                {config.protocol === "anthropic" ? "Anthropic" : "OpenAI"} · {config.model} · Enter 发送 / Shift+Enter 换行
              </div>
            </div>
          </>
        ) : activeTab === "automations" ? (
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
            <p style={{ color: t.textSecondary, fontSize: 13, marginBottom: 16 }}>常用操作，点击快速执行：</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {SAMPLE_AUTOMATIONS.map((a, i) => (
                <button key={i} onClick={() => { setActiveTab("chat"); setInput(a.label); setTimeout(() => inputRef.current?.focus(), 100); }}
                  style={{
                    padding: "14px", borderRadius: 10, border: `1px solid ${t.cardBorder}`, background: t.card,
                    cursor: "pointer", textAlign: "left", transition: "all 0.12s",
                  }}>
                  <div style={{ fontSize: 18, marginBottom: 6 }}>{a.icon}</div>
                  <div style={{ color: t.text, fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{a.label}</div>
                  <div style={{ color: t.textMuted, fontSize: 11 }}>{a.desc}</div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: "18px 22px" }}>
            <p style={{ color: t.textSecondary, fontSize: 13, marginBottom: 14 }}>当前注册的 SolidWorks COM 工具：</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {SW_TOOLS.map((tool, i) => (
                <span key={i} style={{
                  padding: "7px 12px", borderRadius: 6, background: t.toolBg, color: t.toolText,
                  fontSize: 12, fontFamily: "'Consolas', monospace", border: `1px solid ${t.toolBorder}`,
                }}>{tool}</span>
              ))}
            </div>
            <div style={{ marginTop: 20, padding: "14px", borderRadius: 8, background: t.cardAlt, border: `1px solid ${t.cardBorder}` }}>
              <div style={{ color: t.textSecondary, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>工作原理</div>
              <div style={{ color: t.textMuted, fontSize: 12, lineHeight: 1.8 }}>
                1. 自然语言描述操作需求<br />
                2. AI 模型理解意图并选择工具<br />
                3. 生成 SolidWorks VBA 宏或 Python 脚本<br />
                4. 通过 COM 接口注入 SolidWorks 执行<br />
                5. 返回结果并提供后续建议
              </div>
            </div>
          </div>
        )}
      </div>

      {showSettings && <SettingsPanel config={config} setConfig={setConfig} onClose={() => setShowSettings(false)} swConnected={swConnected} t={t} theme={theme} setTheme={setTheme} />}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.35;transform:scale(.78)} }
        *{box-sizing:border-box}
        ::-webkit-scrollbar{width:5px}
        ::-webkit-scrollbar-track{background:transparent}
        ::-webkit-scrollbar-thumb{background:${t.scrollThumb};border-radius:3px}
        ::-webkit-scrollbar-thumb:hover{background:${t.scrollHover}}
        textarea::placeholder,input::placeholder{color:${t.placeholder}}
        select option{background:${t.selectBg};color:${t.text}}
        button:hover{filter:brightness(${theme === "light" ? "0.96" : "1.12"})}
      `}</style>
    </div>
  );
}
