import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, assetUrl } from '../api';
import { loadActiveSession, saveLocal, clearActiveSession } from '../sessionStore';
import ScoreBadge from '../components/ScoreBadge';
import { PatientAvatarButton } from '../components/PatientAvatar';
import LogActions from '../components/LogActions';
import { makeLogItems, evalSection as evalSectionTxt } from '../logFiles';
import { nextActiveElapsed, SESSION_LIMIT_SECONDS, SESSION_LIMIT_MINUTES } from '../sessionLimit';

const SESSION_TYPE = 'simulacao';

// Mensagem invisível enviada à IA no "time skip" entre sessões.
const SKIP_PROMPT = 'O usuário finalizou a sessão de hoje. Agora passaremos para a próxima sessão. Você (o paciente) acaba de entrar na sessão novamente, na próxima semana. Descreva o que aconteceu na sua semana; você já está na sala novamente com o terapeuta.';
const SKIP_MIN_DELAY_MS = 2200;
const SAVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Monta a mensagem (role: user) enviada ao avaliador com a transcrição.
function buildEvaluationMessage(characterName, transcript) {
  return `[LOG DO ATENDIMENTO]\nPersonagem: ${characterName}\n\n${transcript}`;
}

export default function ChatSession({ user }) {
  const { id } = useParams();
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState('');
  const [highlightTarget, setHighlightTarget] = useState(null);
  const [highlightDraft, setHighlightDraft] = useState('');
  const [confirmingFinalize, setConfirmingFinalize] = useState(false);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showSaveLoad, setShowSaveLoad] = useState(false);

  const [sessionNumber, setSessionNumber] = useState(1);
  const [confirmingSkip, setConfirmingSkip] = useState(false);
  const [skipping, setSkipping] = useState(false);

  // Pós-sessão
  const [savingLog, setSavingLog] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState('');
  const [evaluationText, setEvaluationText] = useState('');
  const [evalScore, setEvalScore] = useState(null);

  // Avaliador ligado? (por padrão NÃO — encerra com agradecimento.)
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(false);

  const messagesEndRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const textareaRef = useRef(null);
  const timerRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const restoredRef = useRef(false);
  const finishedRef = useRef(false);
  const sessionDataRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    api.getSettings()
      .then((s) => { if (!cancelled) setEvaluatorEnabled(!!s.evaluatorEnabled); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Carrega personagem + tenta restaurar sessão ativa (F5 / sair e voltar).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const list = await api.getCharacters();
        const found = list.find((i) => String(i.id) === String(id));
        if (cancelled) return;
        if (!found) { setError('Personagem não encontrado.'); return; }
        setItem(found);
        if (!restoredRef.current && user?.id) {
          restoredRef.current = true;
          const saved = await loadActiveSession(user.id, SESSION_TYPE, id);
          if (cancelled) return;
          if (saved && Array.isArray(saved.messages) && saved.messages.length > 0) {
            setMessages(saved.messages);
            setElapsed(saved.elapsedSeconds || 0);
            if (Number.isFinite(saved.sessionNumber) && saved.sessionNumber >= 1) setSessionNumber(saved.sessionNumber);
            setSessionStarted(true);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Erro ao carregar personagem.');
      }
    }
    load();
    return () => { cancelled = true; };
  }, [id, user?.id]);

  // Autosave: localStorage síncrono + servidor com debounce.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !item || !user?.id || finishedRef.current) return;
    const data = { messages, elapsedSeconds: elapsed, itemTitle: item.name, sessionNumber };
    sessionDataRef.current = data;
    saveLocal(user.id, SESSION_TYPE, id, data);
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      if (finishedRef.current) return;
      api.saveActiveSession(SESSION_TYPE, id, data).catch(() => {});
    }, 1500);
    return () => { if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current); };
  }, [messages, elapsed, sessionStarted, sessionEnded, item, sessionNumber, user?.id, id]);

  // Flush ao trocar de rota / fechar aba / background.
  useEffect(() => {
    if (!sessionStarted || sessionEnded || !user?.id) return;
    function flush() {
      if (finishedRef.current) return;
      const data = sessionDataRef.current;
      if (!data) return;
      saveLocal(user.id, SESSION_TYPE, id, data);
      api.saveActiveSession(SESSION_TYPE, id, data).catch(() => {});
    }
    function onVis() { if (document.visibilityState === 'hidden') flush(); }
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [sessionStarted, sessionEnded, user?.id, id]);

  // Cronômetro (só corre com a aba visível e a sessão em andamento).
  useEffect(() => {
    if (sessionStarted && !sessionEnded) {
      timerRef.current = setInterval(() => setElapsed(nextActiveElapsed), 1000);
      return () => clearInterval(timerRef.current);
    }
  }, [sessionStarted, sessionEnded]);

  const limitReached = elapsed >= SESSION_LIMIT_SECONDS;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  function formatTime(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = Math.floor(secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  async function sendToAI(text, currentMessages) {
    const apiMessages = [...currentMessages, { role: 'user', content: text }]
      .filter((m) => m && m.role)
      .map((m) => ({ role: m.role, content: m.content }));
    const data = await api.chat(apiMessages, { type: SESSION_TYPE, itemId: id });
    return typeof data === 'string' ? data : data.content || data.message || '';
  }

  async function handleStartSession() {
    if (!item) return;
    setError('');
    setSessionStarted(true);
    const kickoffMsg = { role: 'user', content: 'Iniciar', isSystem: true, highlighted: false, comment: '' };
    setMessages([kickoffMsg]);
    setIsTyping(true);
    try {
      const reply = await sendToAI('Iniciar', []);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
      textareaRef.current?.focus();
    }
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || isTyping || !sessionStarted || sessionEnded || limitReached) return;
    const userMsg = { role: 'user', content: trimmed, highlighted: false, comment: '' };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsTyping(true);
    try {
      const reply = await sendToAI(trimmed, messages);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'assistant', content: `Erro: ${err.message}` }]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input); }
  }

  function handleSkipSession() {
    if (!sessionStarted || sessionEnded || isTyping || skipping || limitReached) return;
    setConfirmingSkip(true);
  }

  async function doSkipSession() {
    setConfirmingSkip(false);
    if (!sessionStarted || sessionEnded || isTyping || skipping) return;
    // Calcula a partir do estado atual (o guard `skipping` impede skips
    // concorrentes) — não depende do updater do setState, que no React 18 não
    // roda de forma síncrona e deixaria o número do marcador indefinido.
    const newNumber = sessionNumber + 1;
    setSessionNumber(newNumber);
    setSkipping(true);
    const breakMarker = { type: 'session-break', sessionNumber: newNumber, stage: 'transitioning' };
    const hiddenSkip = { role: 'user', content: SKIP_PROMPT, isSystem: true, highlighted: false, comment: '' };
    setMessages([...messages, breakMarker, hiddenSkip]);
    setIsTyping(true);
    const minDelay = new Promise((r) => setTimeout(r, SKIP_MIN_DELAY_MS));
    const flip = (m) => (m && m.type === 'session-break' && m.sessionNumber === newNumber ? { ...m, stage: 'arrived' } : m);
    try {
      const [reply] = await Promise.all([sendToAI(SKIP_PROMPT, messages), minDelay]);
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: reply }));
    } catch (err) {
      setMessages((prev) => prev.map(flip).concat({ role: 'assistant', content: `Erro ao retomar a sessão: ${err.message}` }));
    } finally {
      setIsTyping(false);
      setSkipping(false);
      textareaRef.current?.focus();
    }
  }

  function doReset() {
    setConfirmingReset(false);
    finishedRef.current = true;
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    sessionDataRef.current = null;
    clearActiveSession(user.id, SESSION_TYPE, id);
    setMessages([]); setInput(''); setElapsed(0); setSessionNumber(1); setSessionStarted(false); setError('');
    setTimeout(() => { finishedRef.current = false; }, 0);
  }

  function downloadSave() {
    const save = {
      genusSave: true, version: 1, type: SESSION_TYPE, itemId: String(id), itemTitle: item?.name || '',
      messages, elapsedSeconds: elapsed, sessionNumber, savedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(save, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `genus-save-${(item?.name || 'sessao').replace(/\s+/g, '_')}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleLoadSaveFile(e) {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const save = JSON.parse(reader.result);
        if (!save || save.genusSave !== true || !Array.isArray(save.messages)) throw new Error('Arquivo de save inválido.');
        if (save.type !== SESSION_TYPE || String(save.itemId) !== String(id)) throw new Error('Este save é de outro personagem. Abra o personagem correspondente para carregá-lo.');
        const savedAt = new Date(save.savedAt || 0).getTime();
        if (Number.isFinite(savedAt) && savedAt > 0 && Date.now() - savedAt > SAVE_TTL_MS) throw new Error('Este save expirou — saves valem por 30 dias.');
        finishedRef.current = false;
        setMessages(save.messages);
        setElapsed(Number.isFinite(save.elapsedSeconds) ? save.elapsedSeconds : 0);
        if (Number.isFinite(save.sessionNumber) && save.sessionNumber >= 1) setSessionNumber(save.sessionNumber);
        setSessionStarted(true);
        setError('');
      } catch (err) {
        setError(err.message || 'Não foi possível carregar o save.');
      }
    };
    reader.readAsText(file);
  }

  // Builders de texto (copiar/baixar).
  function buildLogHeader() {
    return [`Terapeuta: ${user?.name || '—'}`, `Paciente: ${item?.name || '—'}`, `Sessões: ${sessionNumber}`].join('\n');
  }
  function buildTranscript() {
    return messages.filter((m) => !m.isSystem && !m.type).map((m) => {
      const author = m.role === 'user' ? (user?.name || 'Terapeuta') : (item?.name || 'Paciente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');
  }
  function buildEvaluationBody() {
    const score = evalScore !== null ? `Nota final: ${evalScore}\n\n` : '';
    return `${score}${(evaluationText || '').trim()}`;
  }
  const logText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}`;
  const evalText = () => `${buildLogHeader()}${evalSectionTxt(buildEvaluationBody())}`.trimEnd();
  const bothText = () => `${buildLogHeader()}\n\n---\n\n${buildTranscript()}${evalSectionTxt(buildEvaluationBody())}`;

  function handleFinalize() {
    if (!sessionStarted || sessionEnded) return;
    setConfirmingFinalize(true);
  }

  async function doFinalize() {
    setConfirmingFinalize(false);
    if (!sessionStarted || sessionEnded) return;
    finishedRef.current = true;
    const visibleMessages = messages.filter((m) => !m.isSystem && !m.type);
    if (timerRef.current) clearInterval(timerRef.current);

    if (visibleMessages.length === 0) {
      setSessionEnded(true);
      clearActiveSession(user.id, SESSION_TYPE, id);
      return;
    }

    setSessionEnded(true);
    setSavingLog(true);
    if (evaluatorEnabled) setEvaluating(true);
    setSaveError('');
    setEvalError('');

    const transcriptText = visibleMessages.map((m) => {
      const author = m.role === 'user' ? user.name : (item?.name || 'Paciente');
      const star = m.highlighted ? ' ★' : '';
      const comment = m.highlighted && m.comment ? `\n   {${m.comment}}` : '';
      return `[${author}${star}]\n${m.content}${comment}`;
    }).join('\n\n---\n\n');

    // 1. Avaliação — só quando o avaliador está LIGADO. Estrutura pronta:
    //    quando ligado, chama /api/evaluate; o servidor injeta o gabarito e
    //    devolve o texto da avaliação.
    let evalContent = '';
    let totalScore = null;
    if (evaluatorEnabled) {
      try {
        const evalMsg = { role: 'user', content: buildEvaluationMessage(item?.name || '—', transcriptText) };
        const reply = await api.evaluate([evalMsg], { type: SESSION_TYPE, itemId: id });
        if (reply && !reply.disabled) {
          evalContent = typeof reply === 'string' ? reply : reply.content || '';
          const m = evalContent.match(/\[NOTA:\s*([-+]?\d+(?:[.,]\d+)?)\s*\]/i);
          if (m) totalScore = Math.round(Number(m[1].replace(',', '.')));
          setEvaluationText(evalContent);
          setEvalScore(totalScore);
        }
      } catch (err) {
        setEvalError(err.message || 'Erro ao avaliar a sessão.');
      } finally {
        setEvaluating(false);
      }
    }

    // 2. Salva o log no histórico (sempre).
    try {
      const saved = await api.saveLog({
        userId: user.id,
        userName: user.name,
        itemId: id,
        itemTitle: item.name,
        messages: visibleMessages.map((m) => ({ role: m.role, content: m.content, highlighted: m.highlighted || false, comment: m.comment || '' })),
        durationSeconds: elapsed,
        sessionCount: sessionNumber,
        score: totalScore,
        evaluation: evalContent,
      });
      if (saved && Number.isFinite(saved.score)) setEvalScore(saved.score);
    } catch (err) {
      setSaveError(err.message || 'Erro ao salvar o log.');
    } finally {
      setSavingLog(false);
    }

    clearActiveSession(user.id, SESSION_TYPE, id);
  }

  async function toggleRecording() {
    if (!sessionStarted || sessionEnded || isTranscribing) return;
    if (isRecording) { mediaRecorderRef.current?.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        setIsTranscribing(true);
        const blob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = reader.result.split(',')[1];
          try {
            const data = await api.transcribe(base64);
            const text = data.text || data.transcription || '';
            setInput((prev) => (prev ? prev + ' ' + text : text));
            textareaRef.current?.focus();
          } catch (err) {
            setError('Erro ao transcrever: ' + err.message);
          } finally {
            setIsTranscribing(false);
          }
        };
        reader.readAsDataURL(blob);
      };
      recorder.start();
      setIsRecording(true);
    } catch (err) {
      setError('Não foi possível acessar o microfone: ' + err.message);
    }
  }

  function openHighlight(idx) {
    const msg = messages[idx];
    if (!msg || msg.role !== 'user') return;
    setHighlightTarget({ idx });
    setHighlightDraft(msg.comment || '');
  }
  function saveHighlight() {
    if (!highlightTarget) return;
    setMessages((prev) => prev.map((m, i) => (i === highlightTarget.idx ? { ...m, highlighted: true, comment: highlightDraft.trim() } : m)));
    setHighlightTarget(null);
    setHighlightDraft('');
  }
  function removeHighlight(idx) {
    setMessages((prev) => prev.map((m, i) => (i === idx ? { ...m, highlighted: false, comment: '' } : m)));
  }

  // -------- TELA DE LOADING (avaliando — só se avaliador ligado) --------
  if (sessionEnded && evaluating) {
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>Avaliando sua <span className="accent">sessão</span></h2>
          <p>A análise do atendimento com {item?.name} pode levar alguns segundos.</p>
          <div className="ornament" />
        </div>
        <div className="card evaluating-card">
          <div className="evaluating-orb"><div className="orb-pulse" /><div className="orb-pulse delay-1" /><div className="orb-pulse delay-2" /><div className="orb-core" /></div>
          <div className="evaluating-status">
            <div className="evaluating-line"><span className="dot active" /> Construindo a transcrição da sessão</div>
            <div className="evaluating-line"><span className="dot pulse" /> Analisando o atendimento</div>
            <div className="evaluating-line"><span className="dot" /> Calculando a nota final</div>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA PÓS-SESSÃO (agradecimento por padrão) --------
  if (sessionEnded) {
    const visibleMessages = messages.filter((m) => !m.isSystem && !m.type);
    const hasEval = !!(evaluationText || '').trim();
    return (
      <div className="post-session">
        <div className="page-header">
          <div className="eyebrow">Sessão concluída</div>
          <h2>Obrigado por <span className="accent">participar</span></h2>
          <p>Sessão com <strong>{item?.name}</strong> · duração {formatTime(elapsed)} · {sessionNumber} {sessionNumber === 1 ? 'sessão' : 'sessões'}</p>
          <div className="ornament" />
        </div>

        {saveError && <div className="alert error">Falha ao salvar log: {saveError}</div>}
        {evalError && <div className="alert error">Falha na avaliação: {evalError}</div>}

        <div className="card">
          {savingLog ? (
            <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-soft)' }}>
              <span className="spinner" /> <span style={{ marginLeft: 12 }}>Salvando log…</span>
            </div>
          ) : (
            <div className="thankyou-block">
              <div className="thankyou-check" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><polyline points="20 6 9 17 4 12" /></svg>
              </div>
              <p className="thankyou-text">
                {hasEval
                  ? 'O log completo desta sessão foi registrado no seu histórico.'
                  : 'Um dos nossos avaliadores recebeu o seu log e fará a análise. Obrigado por participar!'}
              </p>
            </div>
          )}

          <div className="post-session-stats">
            <div><span className="post-stat-label">Duração</span><span className="post-stat-value">{formatTime(elapsed)}</span></div>
            <div><span className="post-stat-label">Sessões</span><span className="post-stat-value">{sessionNumber}</span></div>
            <div><span className="post-stat-label">Mensagens</span><span className="post-stat-value">{visibleMessages.length}</span></div>
            {evalScore !== null && (
              <div><span className="post-stat-label">Nota final</span><ScoreBadge score={evalScore} size="xl" /></div>
            )}
          </div>

          {hasEval && (
            <div className="post-evaluation">
              <h4>Análise</h4>
              <div className="post-evaluation-body">{(evaluationText || '').replace(/\[NOTA:[^\]]+\]\s*/gi, '').trim()}</div>
            </div>
          )}

          {visibleMessages.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <LogActions items={makeLogItems({ baseName: item?.name || 'sessao', getLog: logText, getEval: hasEval ? evalText : null, getBoth: hasEval ? bothText : null })} />
            </div>
          )}

          <div className="post-session-actions">
            <button className="btn btn-primary" onClick={() => navigate('/simulacao')}>Voltar à biblioteca</button>
          </div>
        </div>
      </div>
    );
  }

  // -------- TELA DE CHAT --------
  return (
    <div className="chat-container">
      <div className="chat-header">
        <button onClick={() => navigate(-1)} className="btn btn-outline btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6" /></svg>
          Voltar
        </button>

        {item?.name && <PatientAvatarButton name={item.name} iconUrl={assetUrl(item.photoIcon)} fullUrl={assetUrl(item.photoFull)} size={42} className="chat-header-avatar" />}

        <div className="chat-title">
          <h3>Sessão com {item?.name || '...'}</h3>
          <div className="chat-status">Simulação{sessionStarted && <> · <strong>Sessão #{sessionNumber}</strong></>}</div>
        </div>

        <div className="chat-header-actions">
          {sessionStarted && (
            <div className={`timer-chip ${limitReached ? 'limit' : ''}`} title={limitReached ? `Limite de ${SESSION_LIMIT_MINUTES} min atingido` : 'Tempo no chat (pausa fora dele)'}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
              <span>{formatTime(elapsed)}</span>
            </div>
          )}
          {sessionStarted && (
            <>
              <button className="btn btn-outline btn-sm" onClick={() => setShowSaveLoad(true)} disabled={isTyping || skipping} title="Guardar ou carregar o progresso desta sessão">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>
                Save/Load
              </button>
              <button className="btn btn-outline btn-sm btn-warn" onClick={() => setConfirmingReset(true)} disabled={isTyping || skipping} title="Reiniciar a simulação do zero">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.7 3" /><polyline points="3 3 3 8 8 8" /></svg>
                Reiniciar
              </button>
              <button className="btn btn-sm btn-success" onClick={handleSkipSession} disabled={isTyping || skipping} title="Avançar para a próxima sessão (time skip)">
                Próxima sessão →
              </button>
              <button className="btn btn-secondary btn-sm" onClick={handleFinalize}>Finalizar e enviar</button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="alert error">{error}<button onClick={() => setError('')} className="close">×</button></div>
      )}

      <div className={`chat-messages ${!sessionStarted ? 'locked' : ''}`}>
        {messages.filter((m) => !m.isSystem && !m.type).length === 0 && !sessionStarted && (
          <div className="empty-chat">
            Ao iniciar, {item?.name || 'o paciente'} abre a conversa. Use o botão de destaque (★) para marcar suas próprias intervenções para revisão posterior.
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg && msg.type === 'session-break') {
            const isTransitioning = msg.stage !== 'arrived';
            return (
              <div key={i} className={`session-break ${isTransitioning ? 'transitioning' : 'arrived'}`}>
                <div className="session-break-line" />
                <div className="session-break-card">
                  <div className="session-break-badge">Sessão #{msg.sessionNumber}</div>
                  {isTransitioning ? (
                    <>
                      <div className="session-break-text">A sessão foi encerrada. Passando a semana…</div>
                      <div className="session-break-loader"><span className="dot" /><span className="dot" /><span className="dot" /></div>
                    </>
                  ) : (
                    <div className="session-break-text">Seu paciente chegou para a sessão da próxima semana. Pode iniciar o atendimento.</div>
                  )}
                </div>
                <div className="session-break-line" />
              </div>
            );
          }
          if (msg.isSystem) return null;
          const isUser = msg.role === 'user';
          const author = isUser ? user.name : (item?.name || 'Paciente');
          return (
            <div key={i}>
              <div className={`chat-message-row ${msg.role} ${msg.highlighted ? 'highlighted' : ''}`}>
                <div className="chat-message-author">{msg.highlighted && <span className="star-inline">★</span>} {author}</div>
                <div className={`chat-message ${msg.role}`}>{msg.content}</div>
                {isUser && (
                  <div className="message-tools">
                    {msg.highlighted ? (
                      <>
                        <button className="tool-btn active" onClick={() => openHighlight(i)} title="Editar destaque">★</button>
                        <button className="tool-btn" onClick={() => removeHighlight(i)} title="Remover destaque">×</button>
                      </>
                    ) : (
                      <button className="tool-btn" onClick={() => openHighlight(i)} title="Destacar mensagem">★</button>
                    )}
                  </div>
                )}
                {isUser && msg.highlighted && msg.comment && <div className="highlight-comment">{`{${msg.comment}}`}</div>}
              </div>
            </div>
          );
        })}

        {isTyping && (
          <div className="chat-message-row assistant">
            <div className="chat-message-author">{item?.name || 'Paciente'}</div>
            <div className="chat-message assistant" style={{ fontStyle: 'italic', opacity: 0.7 }}><span className="loading-dots">Pensando</span></div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {!sessionStarted ? (
        <div className="start-session-area">
          <div className="start-session-card">
            <h4>Pronto para começar?</h4>
            <p>Ao iniciar, {item?.name} abrirá a conversa.</p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              <button className="btn btn-primary btn-lg" onClick={handleStartSession} disabled={!item}>Iniciar atendimento</button>
              <button className="btn btn-outline btn-lg" onClick={() => fileInputRef.current?.click()} disabled={!item} title="Retomar a partir de um arquivo de save (.json)">Carregar save</button>
            </div>
          </div>
        </div>
      ) : isTranscribing ? (
        <div className="chat-input-area transcribing">
          <div className="transcribing-indicator"><span className="spinner" /><span>Transcrevendo áudio…</span></div>
        </div>
      ) : limitReached ? (
        <div className="chat-input-area session-limit-bar">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
          <span>Limite de {SESSION_LIMIT_MINUTES} min de sessão atingido. Finalize a sessão para concluir.</span>
        </div>
      ) : (
        <div className="chat-input-area">
          <textarea ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder="Sua intervenção…  ·  Enter envia · Shift+Enter quebra linha" rows={1} disabled={isTyping} />
          <button type="button" className={`icon-btn ${isRecording ? 'recording' : ''}`} onClick={toggleRecording} title={isRecording ? 'Parar gravação' : 'Gravar áudio'} disabled={isTyping}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill={isRecording ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8">
              <rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10a7 7 0 0 0 14 0" /><line x1="12" y1="19" x2="12" y2="22" /><line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          </button>
          <button type="button" className="icon-btn primary" onClick={() => sendMessage(input)} disabled={!input.trim() || isTyping} title="Enviar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" /></svg>
          </button>
        </div>
      )}

      <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={handleLoadSaveFile} style={{ display: 'none' }} />

      {showSaveLoad && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem && !m.type).length;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setShowSaveLoad(false); }}>
            <div className="modal" style={{ maxWidth: 460 }}>
              <h3>Progresso da sessão</h3>
              <p className="modal-text">Guarde o progresso atual num arquivo (.json) para retomar depois, ou carregue um progresso salvo. Carregar substitui a conversa atual.</p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => { setShowSaveLoad(false); fileInputRef.current?.click(); }}>Carregar o progresso</button>
                <button type="button" className="btn btn-primary" onClick={() => { setShowSaveLoad(false); downloadSave(); }} disabled={visibleCount === 0} title={visibleCount === 0 ? 'A sessão ainda não tem mensagens' : 'Baixar o save desta sessão'}>Guardar o progresso</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingFinalize && (() => {
        const visibleCount = messages.filter((m) => !m.isSystem && !m.type).length;
        const empty = visibleCount === 0;
        return (
          <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingFinalize(false); }}>
            <div className="modal" style={{ maxWidth: 500 }}>
              <h3>{empty ? 'Sessão vazia' : 'Finalizar e enviar'}</h3>
              <p className="modal-text">
                {empty
                  ? 'A sessão ainda não tem mensagens. Deseja encerrar mesmo assim?'
                  : 'Tem certeza? O log completo será salvo no seu histórico e enviado para análise. Você não poderá continuar este atendimento depois.'}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn btn-outline" onClick={() => setConfirmingFinalize(false)}>Cancelar</button>
                <button type="button" className="btn btn-primary" onClick={doFinalize}>{empty ? 'Encerrar mesmo assim' : 'Finalizar e enviar'}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {confirmingReset && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingReset(false); }}>
          <div className="modal" style={{ maxWidth: 460 }}>
            <h3>Reiniciar simulação</h3>
            <p className="modal-text">Tem certeza? Toda a conversa, o tempo decorrido e o número da sessão serão <strong>perdidos</strong> e você voltará à tela de início. Esta ação não pode ser desfeita.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingReset(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary btn-warn-solid" onClick={doReset}>Sim, reiniciar</button>
            </div>
          </div>
        </div>
      )}

      {confirmingSkip && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmingSkip(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <h3>Avançar para a próxima sessão</h3>
            <p className="modal-text">Tem certeza que deseja ir para a próxima sessão? Lembre-se de fazer um encerramento primeiro com seu paciente — essa função é um <em>time skip</em>.</p>
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setConfirmingSkip(false)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={doSkipSession}>Passar para a próxima sessão</button>
            </div>
          </div>
        </div>
      )}

      {highlightTarget && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setHighlightTarget(null); }}>
          <div className="modal" style={{ maxWidth: 520 }}>
            <h3>Destacar mensagem</h3>
            <p className="modal-text">Por que você está destacando essa intervenção? <em>(opcional)</em></p>
            <textarea value={highlightDraft} onChange={(e) => setHighlightDraft(e.target.value)} placeholder="Ex: testei uma reformulação, paciente reagiu emocionalmente…" style={{ minHeight: 120 }} autoFocus />
            <div className="modal-actions">
              <button type="button" className="btn btn-outline" onClick={() => setHighlightTarget(null)}>Cancelar</button>
              <button type="button" className="btn btn-primary" onClick={saveHighlight}>Salvar destaque</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
