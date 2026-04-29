// src/renderer/App.tsx
//
// App 现在是纯编排层:挂 hook、拼组件、路由标签。
// 每个子组件只关心自己职责。脚本执行作为新增能力在这里集成。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, LLMConfig, ScriptResult } from '../shared/types';
import { DEFAULT_CONFIG } from '../shared/presets';
import { useTheme } from './hooks/useTheme';
import { useLLM } from './hooks/useLLM';
import { useSWStatus } from './hooks/useSWStatus';
import { Sidebar, type TabKey } from './components/Sidebar';
import { Chat } from './components/Chat';
import { ChatInput, type ChatInputHandle } from './components/ChatInput';
import { SettingsModal } from './components/SettingsModal';
import { Automations } from './components/Automations';
import { ToolsList } from './components/ToolsList';
import { ErrorBanner } from './components/ErrorBanner';

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    role: 'assistant',
    content:
      '你好,我是 SW Copilot。\n\n先到左下角「设置」配置 AI 服务商(Anthropic / OpenAI / 百炼 / DeepSeek …),之后就能用自然语言驱动 SolidWorks。\n\n当 AI 回复里包含代码,你可以直接点「执行」把脚本注入 SolidWorks,或「复制」到自己的宏环境中用。',
  },
];

export default function App() {
  const { theme, setTheme, toggle, tokens: t } = useTheme();

  // —— 配置 ——
  const [config, setConfig] = useState<LLMConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    window.api.config.load().then(setConfig);
  }, []);

  // —— SW 状态 ——
  const { status: swStatus, loading: swLoading, reconnect } = useSWStatus();

  // —— 聊天 ——
  const { messages, isGenerating, error: llmError, send, cancel, reset, setMessages } = useLLM({
    config,
    initial: INITIAL_MESSAGES,
  });

  // 错误横幅状态
  const [dismissedError, setDismissedError] = useState(false);
  // 新错误出现时重新显示
  const prevErrorRef = useRef(llmError);
  if (llmError !== prevErrorRef.current) {
    prevErrorRef.current = llmError;
    if (llmError) setDismissedError(false);
  }

  // —— 视图状态 ——
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<ChatInputHandle>(null);

  // —— 脚本执行 ——
  // execResults 按消息索引存执行结果
  const [execResults, setExecResults] = useState<Record<number, ScriptResult>>({});
  const [executingIndex, setExecutingIndex] = useState<number | null>(null);

  const handleSend = useCallback(() => {
    const value = input.trim();
    if (!value || isGenerating) return;
    setInput('');
    send(value);
  }, [input, isGenerating, send]);

  const handleClear = useCallback(() => {
    reset(true);
    setExecResults({});
    setExecutingIndex(null);
  }, [reset]);

  // 用户点了自动化模板:切回 chat 标签,填入输入框并聚焦
  const handlePickAutomation = useCallback((prompt: string) => {
    setActiveTab('chat');
    setInput(prompt);
    // 等 chat 标签挂载完再 focus
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // 点击消息里的"执行"按钮
  const handleRunScript = useCallback(
    async (msgIndex: number, code: string, lang: 'vba' | 'python') => {
      if (executingIndex !== null) return; // 串行执行,避免同时改 SolidWorks 状态

      // 执行前先做一次安全校验(主进程已经做过,这里是拦截用户已确认前的意外)
      const validation = await window.api.script.validate(code, lang);
      if (!validation.safe) {
        const confirmed = window.confirm(
          `检测到潜在风险:\n\n${validation.issues.join('\n')}\n\n仍要继续执行吗?`,
        );
        if (!confirmed) return;
      }

      setExecutingIndex(msgIndex);
      try {
        const result = await window.api.script.run(code, lang);
        setExecResults((prev) => ({ ...prev, [msgIndex]: result }));
      } finally {
        setExecutingIndex(null);
      }
    },
    [executingIndex],
  );

  const handleCopyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {
      // 环境可能不支持 clipboard(比如测试渲染),忽略即可
    });
  }, []);

  const handleSettingsChange = useCallback((next: LLMConfig) => {
    setConfig(next);
  }, []);

  const tabTitle: Record<TabKey, string> = {
    chat: '💬 对话',
    automations: '⚡ 快捷自动化',
    tools: '🔧 可用工具',
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100vh',
        display: 'flex',
        background: t.bg,
        color: t.text,
        overflow: 'hidden',
        fontFamily: "'Segoe UI', -apple-system, sans-serif",
        transition: 'background 0.25s, color 0.25s',
      }}
    >
      <Sidebar
        t={t}
        theme={theme}
        onToggleTheme={toggle}
        onOpenSettings={() => setShowSettings(true)}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        config={config}
        swStatus={swStatus}
        onReconnectSW={reconnect}
        swLoading={swLoading}
      />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 错误横幅 */}
        {!dismissedError && (
          <ErrorBanner
            t={t}
            swStatus={swStatus}
            llmError={llmError}
            onReconnectSW={reconnect}
            onDismissError={() => setDismissedError(true)}
            onOpenSettings={() => setShowSettings(true)}
          />
        )}
        <header
          style={{
            height: 48,
            borderBottom: `1px solid ${t.sidebarBorder}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 18px',
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: 13, color: t.textSecondary, fontWeight: 500 }}>
            {tabTitle[activeTab]}
          </span>
          {activeTab === 'chat' && messages.length > 1 && (
            <button
              onClick={handleClear}
              style={{
                background: 'none',
                border: `1px solid ${t.cardBorder}`,
                color: t.textMuted,
                padding: '4px 10px',
                borderRadius: 5,
                cursor: 'pointer',
                fontSize: 11,
                fontFamily: 'inherit',
              }}
            >
              清空对话
            </button>
          )}
        </header>

        {activeTab === 'chat' && (
          <>
            <Chat
              t={t}
              messages={messages}
              isGenerating={isGenerating}
              execResults={execResults}
              executingIndex={executingIndex}
              onRunScript={handleRunScript}
              onCopyCode={handleCopyCode}
            />
            <ChatInput
              ref={inputRef}
              t={t}
              value={input}
              onChange={setInput}
              onSend={handleSend}
              onCancel={cancel}
              isGenerating={isGenerating}
              placeholder={
                !config.apiKey
                  ? '请先在「设置」中配置 API…'
                  : '描述你想在 SolidWorks 中执行的操作…'
              }
              hint={`${config.protocol} · ${config.model || '(未指定模型)'} · Enter 发送 / Shift+Enter 换行`}
            />
          </>
        )}

        {activeTab === 'automations' && <Automations t={t} onPick={handlePickAutomation} />}

        {activeTab === 'tools' && <ToolsList t={t} />}
      </main>

      {showSettings && (
        <SettingsModal
          t={t}
          config={config}
          onConfigChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
          swStatus={swStatus}
          theme={theme}
          onThemeChange={setTheme}
        />
      )}
    </div>
  );
}
