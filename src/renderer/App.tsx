// src/renderer/App.tsx
//
// `App` is now a pure orchestration layer: mount hooks, glue components together, switch tabs.
// Each child component only worries about its own concern. Script execution is wired in here
// as a new capability.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage, LLMConfig, ScriptResult } from '../shared/types';
import { DEFAULT_CONFIG } from '../shared/presets';
import { useTheme } from './hooks/useTheme';
import { useLLM } from './hooks/useLLM';
import { useSWStatus } from './hooks/useSWStatus';
import { useChatSessions } from './hooks/useChatSessions';
import { useT } from './i18n/LocaleContext';
import { Sidebar, type TabKey } from './components/Sidebar';
import { Chat } from './components/Chat';
import { ChatInput, type ChatInputHandle } from './components/ChatInput';
import { SettingsModal } from './components/SettingsModal';
import { Automations } from './components/Automations';
import { ToolsList } from './components/ToolsList';
import { ErrorBanner } from './components/ErrorBanner';

export default function App() {
  const { theme, setTheme, toggle, tokens: t } = useTheme();
  const tr = useT();

  // Build the greeting message from the current locale.
  // `useMemo` keeps the array reference stable so `useLLM`'s initial effect doesn't re-run on every render.
  const INITIAL_MESSAGES = useMemo<ChatMessage[]>(
    () => [{ role: 'assistant', content: tr('app.greeting') }],
    [tr],
  );

  // P4: keep the greeting in the active language while the chat is untouched
  useEffect(() => {
    if (
      messages.length === 1 &&
      messages[0].role === 'assistant' &&
      messages[0].content !== INITIAL_MESSAGES[0].content
    ) {
      setMessages(INITIAL_MESSAGES);
    }
  }, [INITIAL_MESSAGES]);

  // —— Config ——
  const [config, setConfig] = useState<LLMConfig>(DEFAULT_CONFIG);
  useEffect(() => {
    window.api.config.load().then(setConfig);
  }, []);

  // —— SolidWorks status ——
  const { status: swStatus, loading: swLoading, reconnect } = useSWStatus();

  // —— Chat ——
  const { messages, isGenerating, error: llmError, send, cancel, reset, setMessages } = useLLM({
    config,
    initial: INITIAL_MESSAGES,
  });

  // —— Conversation-history persistence ——
  const {
    sessions,
    currentId: currentSessionId,
    save: persistSession,
    select: loadSession,
    startNew: startNewSession,
    remove: removeSession,
  } = useChatSessions();

  // Error banner visibility
  const [dismissedError, setDismissedError] = useState(false);
  // Re-display the banner whenever a new error appears
  const prevErrorRef = useRef(llmError);
  if (llmError !== prevErrorRef.current) {
    prevErrorRef.current = llmError;
    if (llmError) setDismissedError(false);
  }

  // —— View state ——
  const [input, setInput] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('chat');
  const [showSettings, setShowSettings] = useState(false);
  const inputRef = useRef<ChatInputHandle>(null);

  // —— Script execution ——
  // `execResults` is keyed by message index
  const [execResults, setExecResults] = useState<Record<number, ScriptResult>>({});
  const [executingIndex, setExecutingIndex] = useState<number | null>(null);

  // Auto-persist whenever the conversation changes (only after generation finishes, and only when there is real content)
  useEffect(() => {
    if (isGenerating) return;
    if (messages.length <= INITIAL_MESSAGES.length) return;
    const tid = setTimeout(() => {
      void persistSession(messages);
    }, 600);
    return () => clearTimeout(tid);
  }, [messages, isGenerating, persistSession]);

  const handleSend = useCallback(() => {
    const value = input.trim();
    if (!value || isGenerating) return;
    setInput('');
    send(value);
  }, [input, isGenerating, send]);

  const handleClear = useCallback(() => {
    startNewSession();
    reset(true);
    setExecResults({});
    setExecutingIndex(null);
  }, [reset, startNewSession]);

  // "New chat" — open a fresh session and reset to the greeting message
  const handleNewChat = useCallback(() => {
    startNewSession();
    setMessages(INITIAL_MESSAGES);
    setExecResults({});
    setExecutingIndex(null);
    setActiveTab('chat');
  }, [startNewSession, setMessages]);

  // Selecting a historical session — load its full messages
  const handleSelectSession = useCallback(
    async (id: string) => {
      const s = await loadSession(id);
      if (s) {
        setMessages(s.messages.length ? s.messages : INITIAL_MESSAGES);
        setExecResults({});
        setExecutingIndex(null);
        setActiveTab('chat');
      }
    },
    [loadSession, setMessages],
  );

  // Deleting a historical session — if it's the active one, reset the view
  const handleDeleteSession = useCallback(
    async (id: string) => {
      await removeSession(id);
      if (id === currentSessionId) {
        setMessages(INITIAL_MESSAGES);
        setExecResults({});
        setExecutingIndex(null);
      }
    },
    [removeSession, currentSessionId, setMessages],
  );

  // User clicked an automation template — switch back to the chat tab, fill the input, and focus it
  const handlePickAutomation = useCallback((prompt: string) => {
    setActiveTab('chat');
    setInput(prompt);
    // Wait for the chat tab to mount before focusing
    setTimeout(() => inputRef.current?.focus(), 50);
  }, []);

  // User clicked the "Run" button on a message
  const handleRunScript = useCallback(
    async (msgIndex: number, code: string, lang: 'vba' | 'python') => {
      if (executingIndex !== null) return; // run serially to avoid mutating SolidWorks state concurrently

      // Run a safety check before execution (the main process already does this; the second pass here is a belt-and-suspenders guard)
      const validation = await window.api.script.validate(code, lang);
      if (!validation.safe) {
        const confirmed = window.confirm(
          tr('app.riskConfirm', { issues: validation.issues.join('\n') }),
        );
        if (!confirmed) return;
      }

      setExecutingIndex(msgIndex);
      try {
        const result = await window.api.script.run(code, lang);
        setExecResults((prev) => ({ ...prev, [msgIndex]: result }));
        // P5: feed the execution outcome back into the conversation so the model can react next turn
        setMessages((prev) => [...prev, {
          role: 'system',
          content: result.success
            ? `[脚本执行结果] ✅ 成功 (${result.duration}ms)${result.output ? `：${result.output.slice(0, 800)}` : ''}`
            : `[脚本执行结果] ❌ 失败：${(result.error ?? '未知错误').slice(0, 800)}`,
          timestamp: Date.now(),
        }]);
      } finally {
        setExecutingIndex(null);
      }
    },
    [executingIndex],
  );

  const handleCopyCode = useCallback((code: string) => {
    navigator.clipboard.writeText(code).catch(() => {
      // The environment may not expose a clipboard (e.g. during tests) — silently ignore
    });
  }, []);

  const handleSettingsChange = useCallback((next: LLMConfig) => {
    setConfig(next);
  }, []);

  const tabTitle: Record<TabKey, string> = {
    chat: tr('header.chat'),
    automations: tr('header.automations'),
    tools: tr('header.tools'),
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
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onNewChat={handleNewChat}
      />

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* Error banner */}
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
              {tr('app.clearChat')}
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
                  ? tr('input.placeholderNoKey')
                  : tr('input.placeholder')
              }
              hint={`${config.protocol} · ${config.model || tr('input.noModel')} · ${tr('input.enterHint')}`}
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
