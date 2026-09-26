const $ = (selector) => document.querySelector(selector);

const dailyPreferenceVersion = '20-total-v1';
if (localStorage.getItem('stella-word-coach-daily-preference-version') !== dailyPreferenceVersion) {
  localStorage.setItem('stella-word-coach-daily-count', '20');
  localStorage.setItem('stella-word-coach-daily-preference-version', dailyPreferenceVersion);
}
const storedDailyCount = Number(localStorage.getItem('stella-word-coach-daily-count'));
const state = {
  words: [], contexts: {}, session: [], position: 0,
  dailyCount: Number.isFinite(storedDailyCount) && storedDailyCount >= 3 ? storedDailyCount : 20,
  sessionStartedAt: Date.now(), sessionFinishedAt: null,
  saveTimer: null, saveGeneration: 0, lastSavedGeneration: 0,
  phoneticCache: new Map(),
  youglishEnabled: localStorage.getItem('stella-word-coach-youglish') === 'enabled',
  youglishReady: false, youglishWidget: null, youglishPendingWord: null,
  youglishAccent: 'us', youglishCaption: '', youglishVideoId: '', youglishTrack: 0, youglishTotal: 0,
  youglishExamples: [], youglishCollecting: false, youglishTargetSeen: false,
  youglishManualCaption: false, youglishCaptureTimer: null, youglishRestoreScrollY: null,
  aiConfigured: false, aiModel: '', aiSettings: {}, aiChats: new Map(), aiBusy: false,
};

const fields = {
  note: $('#my-note'), example: $('#my-example'), context: $('#my-context'), pronunciation_note: $('#pronunciation-note'),
};

function localDateKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function todaySeed() { return Number(localDateKey().replaceAll('-', '')) || 1; }
function seededSort(rows) {
  const seed = todaySeed();
  return [...rows].sort((a, b) => ((a.source_number * 9301 + seed * 49297) % 233280) - ((b.source_number * 9301 + seed * 49297) % 233280));
}

function daysBetween(fromDateKey, toDateKey) {
  return Math.round((new Date(`${toDateKey}T00:00:00`) - new Date(`${fromDateKey}T00:00:00`)) / 86400000);
}

function buildSession() {
  const today = localDateKey();
  const enriched = new Set(Object.keys(state.contexts));
  const due = state.words.filter((word) => word.next_review && word.next_review <= today);
  const newEnriched = state.words.filter((word) => !word.review_count && enriched.has(word.word.toLowerCase()));
  const newOther = state.words.filter((word) => !word.review_count && !enriched.has(word.word.toLowerCase()));
  const familiar = state.words.filter((word) => word.review_count && !due.includes(word));
  const newWords = [...seededSort(newEnriched), ...seededSort(newOther)];

  // Anki/SM-2-style fixed new-word quota: new words are introduced at a steady rate
  // independent of how large the review backlog is, so a growing due queue can never
  // stall the list forever (the original bug — 528 of 567 words had never been shown).
  const minNewSlots = Math.min(newWords.length, Math.max(3, Math.round(state.dailyCount * 0.3)));

  // Most-overdue-first within the due bucket: the forgetting curve means a word further
  // past its scheduled review date has decayed further and is at greater risk of being
  // lost, so it gets first claim on the remaining slots (desirable-difficulty priority,
  // not the previous pseudo-random daily shuffle).
  const dueByUrgency = [...due].sort((a, b) => daysBetween(b.next_review, today) - daysBetween(a.next_review, today));
  const dueBudget = Math.max(0, state.dailyCount - minNewSlots);

  const candidates = [...dueByUrgency.slice(0, dueBudget), ...newWords, ...dueByUrgency.slice(dueBudget), ...seededSort(familiar)];
  const seen = new Set();
  state.session = candidates.filter((word) => !seen.has(word.source_number) && seen.add(word.source_number)).slice(0, state.dailyCount);
  state.position = Math.min(state.position, Math.max(0, state.session.length - 1));
}

function currentWord() { return state.session[state.position]; }
function titleCase(value) { return value ? value[0].toUpperCase() + value.slice(1) : 'New'; }
function fallbackContext(word) {
  return {
    meaning: 'Use the dictionary and real-voice example to build a plain-English meaning you trust.',
    daily: `Listen for “${word}” in a full sentence, then connect it to your own life.`,
    natural: 'This word has not been manually curated yet. Ask AI about its connotation or save your own observation.',
    scene: 'PlayPhrase can help you check what kind of film or TV scene this word appears in.',
  };
}

async function lookupPhonetic(word) {
  const key = word.toLowerCase();
  if (state.phoneticCache.has(key)) return state.phoneticCache.get(key);
  const curated = state.contexts[key]?.phonetic;
  if (curated) { state.phoneticCache.set(key, curated); return curated; }
  try {
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    if (!response.ok) throw new Error('not found');
    const data = await response.json();
    const phonetic = data.flatMap((entry) => [entry.phonetic, ...(entry.phonetics || []).map((item) => item.text)]).find(Boolean);
    const display = phonetic || 'Listen for stress and syllables ↓';
    state.phoneticCache.set(key, display);
    return display;
  } catch { return 'Listen for stress and syllables ↓'; }
}

function speak(text, rate = .9) {
  if (!('speechSynthesis' in window)) { toast('Audio is not supported in this browser.'); return; }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'en-US'; utterance.rate = rate;
  const voices = window.speechSynthesis.getVoices();
  utterance.voice = voices.find((voice) => voice.lang === 'en-US' && /Samantha|Ava|Google US|Microsoft/.test(voice.name)) || voices.find((voice) => voice.lang === 'en-US') || null;
  window.speechSynthesis.speak(utterance);
}

function cleanYouglishCaption(value = '') {
  let decoded = String(value);
  try { decoded = decodeURIComponent(decoded.replaceAll('+', ' ')); } catch { /* retain original */ }
  return decoded.replaceAll('[[[', '').replaceAll(']]]', '').replace(/\s+/g, ' ').trim();
}

function comparableToken(token) { return token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ''); }
function mergeCaption(existing, incoming) {
  const left = String(existing || '').trim();
  const right = String(incoming || '').trim();
  if (!left) return right;
  if (!right || left === right) return left;
  if (right.toLowerCase().includes(left.toLowerCase())) return right;
  if (left.toLowerCase().includes(right.toLowerCase())) return left;
  const leftWords = left.split(/\s+/); const rightWords = right.split(/\s+/);
  let overlap = 0;
  for (let size = Math.min(18, leftWords.length, rightWords.length); size > 0; size -= 1) {
    const suffix = leftWords.slice(-size).map(comparableToken).join(' ');
    const prefix = rightWords.slice(0, size).map(comparableToken).join(' ');
    if (suffix && suffix === prefix) { overlap = size; break; }
  }
  const merged = [...leftWords, ...rightWords.slice(overlap)];
  return merged.slice(-70).join(' ');
}

function usefulCaption(text = state.youglishCaption) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const query = currentWord()?.word.toLowerCase() || '';
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  const matching = sentences.find((sentence) => sentence.toLowerCase().includes(query));
  if (matching && matching.split(/\s+/).length >= 4) return matching;
  return clean.split(/\s+/).slice(-45).join(' ');
}

function setCaptionDisplay(message = '') {
  const editor = $('#youglish-caption');
  if (!state.youglishManualCaption) editor.value = usefulCaption();
  $('#save-caption').disabled = !editor.value.trim() || !state.youglishVideoId;
  $('#caption-state').textContent = message || (editor.value.trim() ? 'Editable before saving' : 'Waiting for speech…');
  renderAiContextLine();
}

function resetYouglishForWord(word) {
  clearTimeout(state.youglishCaptureTimer);
  Object.assign(state, { youglishCaption: '', youglishVideoId: '', youglishTrack: 0, youglishTotal: 0, youglishExamples: [], youglishCollecting: true, youglishTargetSeen: false, youglishManualCaption: false });
  $('#youglish-caption').value = '';
  setCaptionDisplay('Waiting for speech…');
  $('#example-tray-status').textContent = 'Collecting up to 5 sentence contexts…';
  renderExampleTray();
  if (!state.youglishEnabled) return;
  if (state.youglishReady && state.youglishWidget) state.youglishWidget.fetch(word, 'english', state.youglishAccent);
  else state.youglishPendingWord = word;
}

function loadYouglish() {
  state.youglishRestoreScrollY = window.scrollY < 180 ? window.scrollY : null;
  $('#youglish-consent').hidden = true; $('#video-placeholder').hidden = true; $('#youglish-experience').hidden = false;
  if (window.YG || document.querySelector('script[data-youglish-api]')) {
    if (state.youglishReady && currentWord()) resetYouglishForWord(currentWord().word);
    return;
  }
  const script = document.createElement('script');
  script.src = 'https://youglish.com/public/emb/widget.js'; script.async = true; script.dataset.youglishApi = 'true';
  script.onerror = () => { $('#example-tray-status').textContent = 'YouGlish could not load. Check your internet connection.'; };
  document.head.appendChild(script);
}

window.onYouglishAPIReady = function onYouglishAPIReady() {
  const width = $('#youglish-widget').clientWidth || 760;
  const height = Math.max(420, Math.min(540, Math.round(width * .66)));
  state.youglishWidget = new window.YG.Widget('youglish-widget', {
    height, autoStart: 0,
    components: 8, // caption only: no redundant "How to pronounce…" title or dictionary/phonetic panels
    restrictionMode: 1, backgroundColor: '#fffdf8', textColor: '#596460', linkColor: '#235565',
    captionColor: '#235565', markerColor: '#df765c', captionSize: 22,
    events: {
      onFetchDone: onYouglishFetchDone, onVideoChange: onYouglishVideoChange,
      onCaptionChange: onYouglishCaptionChange, onCaptionConsumed: onYouglishCaptionConsumed,
      onPlayerReady: onYouglishPlayerReady, onError: onYouglishError,
    },
  });
  state.youglishReady = true;
  const word = state.youglishPendingWord || currentWord()?.word;
  state.youglishPendingWord = null;
  if (word) state.youglishWidget.fetch(word, 'english', state.youglishAccent);
};

function onYouglishFetchDone(event) {
  state.youglishTotal = Number(event.totalResult || 0);
  if (!state.youglishTotal) {
    state.youglishCollecting = false; $('#example-tray-status').textContent = 'No YouGlish result found.'; renderExampleTray(); return;
  }
  $('#example-tray-status').textContent = `Collecting 5 from ${state.youglishTotal.toLocaleString()} available examples…`;
  attemptYouglishPlay();
}

function attemptYouglishPlay() {
  try {
    const result = state.youglishWidget.play();
    // Browsers block autoplay that isn't a direct, synchronous reaction to a click; this
    // call happens after a network round trip, so the click's "gesture" has already expired
    // and the promise rejects silently unless we catch it and prompt the user instead.
    if (result && typeof result.catch === 'function') {
      result.catch(() => { $('#example-tray-status').textContent = 'Tap ↻ Replay to start the video (your browser blocked autoplay).'; });
    }
  } catch { $('#example-tray-status').textContent = 'Tap ↻ Replay to start the video.'; }
}

function onYouglishVideoChange(event) {
  clearTimeout(state.youglishCaptureTimer);
  Object.assign(state, { youglishVideoId: String(event.video || ''), youglishTrack: Number(event.trackNumber || 0), youglishCaption: '', youglishTargetSeen: false, youglishManualCaption: false });
  $('#youglish-caption').value = '';
  setCaptionDisplay('Building sentence context…');
}

function scheduleExampleCapture() {
  clearTimeout(state.youglishCaptureTimer);
  state.youglishCaptureTimer = setTimeout(() => {
    if (!state.youglishCollecting || !state.youglishTargetSeen || !state.youglishVideoId) return;
    const caption = usefulCaption();
    const alreadyCaptured = state.youglishExamples.some((item) => item.video_id === state.youglishVideoId);
    if (caption && !alreadyCaptured) {
      state.youglishExamples.push({ caption, video_id: state.youglishVideoId, track_number: state.youglishTrack, accent: state.youglishAccent });
      renderExampleTray();
    }
    if (state.youglishExamples.length < Math.min(5, state.youglishTotal)) {
      state.youglishTargetSeen = false;
      try { state.youglishWidget.next(); } catch { /* user can navigate manually */ }
    } else {
      state.youglishCollecting = false;
      $('#example-tray-status').textContent = '5 sentence contexts ready · save only the useful ones';
    }
  }, 1500);
}

function onYouglishCaptionChange(event) {
  const raw = String(event.caption || '');
  const caption = cleanYouglishCaption(raw);
  if (!caption) return;
  state.youglishCaption = mergeCaption(state.youglishCaption, caption);
  const query = currentWord()?.word.toLowerCase() || '';
  if (raw.includes('[[[') || caption.toLowerCase().includes(query)) state.youglishTargetSeen = true;
  setCaptionDisplay('Building from rolling captions · you can edit anytime');
  if (state.youglishTargetSeen) scheduleExampleCapture();
}

function onYouglishCaptionConsumed() { if (state.youglishTargetSeen) scheduleExampleCapture(); }
function onYouglishPlayerReady() {
  if (state.youglishRestoreScrollY !== null) {
    const target = state.youglishRestoreScrollY; state.youglishRestoreScrollY = null;
    requestAnimationFrame(() => window.scrollTo({ top: target, behavior: 'auto' }));
  }
  if (state.youglishCollecting) attemptYouglishPlay();
}
function onYouglishError() { state.youglishCollecting = false; $('#example-tray-status').textContent = 'The player hit an error. Try the next speaker.'; }

function isExampleSaved(item) {
  return (currentWord()?.real_examples || []).some((saved) => saved.video_id === item.video_id && saved.caption === item.caption);
}
function renderExampleTray() {
  const tray = $('#example-tray'); tray.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const item = state.youglishExamples[index];
    const row = document.createElement('div'); row.className = `example-item${item ? '' : ' waiting'}`;
    const number = document.createElement('span'); number.className = 'example-index'; number.textContent = String(index + 1);
    const text = document.createElement('p'); text.className = 'example-text'; text.textContent = item?.caption || 'Waiting for another speaker…';
    row.append(number, text);
    if (item) {
      const actions = document.createElement('div'); actions.className = 'example-actions';
      const play = document.createElement('button'); play.type = 'button'; play.textContent = 'Play'; play.addEventListener('click', () => goToYouglishExample(item));
      const save = document.createElement('button'); save.type = 'button'; save.className = 'save-example'; save.textContent = isExampleSaved(item) ? 'Saved ✓' : 'Save'; save.disabled = isExampleSaved(item); save.addEventListener('click', () => saveYouglishExample(item));
      actions.append(play, save); row.append(actions);
    }
    tray.append(row);
  }
}
async function goToYouglishExample(item) {
  if (!state.youglishWidget) return;
  const delta = Number(item.track_number) - Number(state.youglishTrack); const method = delta >= 0 ? 'next' : 'previous';
  for (let step = 0; step < Math.abs(delta); step += 1) { state.youglishWidget[method](); await new Promise((resolve) => setTimeout(resolve, 320)); }
  state.youglishWidget.replay();
}
async function saveYouglishExample(item) {
  const row = currentWord();
  try {
    const response = await fetch('/api/save-real-example', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_number: row.source_number, caption: item.caption, video_id: item.video_id, accent: item.accent }) });
    const data = await response.json();
    if (!response.ok || !data.saved) throw new Error(data.error || 'Example was not saved');
    Object.assign(row, data.word); setSaveState('', 'Saved in Obsidian');
    $('#save-time').textContent = `Example saved at ${formatTime(data.word.updated_at)}`; $('#obsidian-path').textContent = data.word.obsidian_path;
    renderExampleTray(); toast('Full sentence context saved to Obsidian.');
  } catch (error) { toast(error.message); }
}

async function refreshWordFromObsidian(row) {
  try { const response = await fetch(`/api/word?number=${encodeURIComponent(row.source_number)}`); if (!response.ok) return; const data = await response.json(); if (data.word) Object.assign(row, data.word); } catch { /* keep session copy */ }
}
function renderPersonalNote() {
  const note = fields.note.value.trim(); $('#note-preview').textContent = note;
  if (!$('#note-editor').hidden) { $('#note-add').hidden = true; $('#note-preview-wrap').hidden = true; return; }
  $('#note-add').hidden = Boolean(note); $('#note-preview-wrap').hidden = !note;
}
function setNoteEditor(open) {
  $('#note-editor').hidden = !open;
  if (open) { $('#note-add').hidden = true; $('#note-preview-wrap').hidden = true; fields.note.focus(); } else renderPersonalNote();
}

function currentAiChat(row = currentWord()) {
  if (!row) return [];
  if (!state.aiChats.has(row.source_number)) state.aiChats.set(row.source_number, []);
  return state.aiChats.get(row.source_number);
}
function setAiPanel(open) {
  $('#ai-panel').hidden = !open; $('#ai-toggle').setAttribute('aria-expanded', String(open)); $('#ai-toggle').lastElementChild.textContent = open ? '−' : '＋';
  if (open && state.aiConfigured) $('#ai-question').focus();
}
function renderAiContextLine() {
  const line = $('#ai-context-line'); if (!line) return;
  const hasVideo = Boolean($('#youglish-caption')?.value.trim());
  line.textContent = hasVideo ? 'AI sees: this word + app meaning + your note + the current editable video context.' : 'AI sees: this word + app meaning + your note. Video context will be included once captions appear.';
}
function addAiAnswerToNote(answer) {
  const noteReady = answer.match(/Note-ready:\s*([\s\S]+)$/i)?.[1]?.trim(); const addition = `AI clarification: ${noteReady || answer.trim()}`;
  fields.note.value = fields.note.value.trim() ? `${fields.note.value.trim()}\n\n${addition}` : addition;
  fields.note.dispatchEvent(new Event('input', { bubbles: true })); setNoteEditor(true); toast('Added to your note · saving to Obsidian');
}
function renderAiCoach() {
  const row = currentWord(); if (!row) return; const chat = currentAiChat(row);
  $('#ai-word').textContent = row.word; $('#ai-toggle').firstElementChild.textContent = chat.length ? `✦ Continue AI chat about ${row.word}` : `✦ Ask AI about ${row.word}`;
  $('#ai-status').textContent = state.aiConfigured ? `${state.aiModel || 'AI'} ready` : 'Setup needed'; $('#ai-status').className = `ai-status${state.aiConfigured ? '' : ' needs-setup'}`;
  $('#ai-question').disabled = !state.aiConfigured || state.aiBusy; $('#ai-send').disabled = !state.aiConfigured || state.aiBusy; $('#ai-send').textContent = state.aiBusy ? 'Thinking…' : 'Ask';
  document.querySelectorAll('[data-ai-question]').forEach((button) => { button.disabled = !state.aiConfigured || state.aiBusy; });
  renderAiContextLine();
  const messages = $('#ai-messages'); messages.replaceChildren();
  if (!state.aiConfigured) {
    const setup = document.createElement('div'); setup.className = 'ai-message setup'; setup.textContent = 'AI is not connected yet. Open Settings to add an OpenAI or Superlinear-compatible token.';
    messages.append(setup);
  }
  chat.forEach((item) => {
    const message = document.createElement('div'); message.className = `ai-message ${item.role}`; message.textContent = item.content;
    if (item.role === 'assistant') { const actions = document.createElement('div'); actions.className = 'ai-message-actions'; const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Add useful part to my note'; save.addEventListener('click', () => addAiAnswerToNote(item.content)); actions.append(save); message.append(actions); }
    messages.append(message);
  });
  messages.scrollTop = messages.scrollHeight;
}
async function askAi(question) {
  const row = currentWord(); const cleanQuestion = question.trim(); if (!row || !cleanQuestion || state.aiBusy) return;
  const chat = currentAiChat(row); const history = chat.filter((item) => ['user', 'assistant'].includes(item.role)).slice(-8).map((item) => ({ role: item.role, content: item.content }));
  chat.push({ role: 'user', content: cleanQuestion }); state.aiBusy = true; $('#ai-question').value = ''; renderAiCoach();
  const context = state.contexts[row.word.toLowerCase()] || fallbackContext(row.word);
  try {
    const response = await fetch('/api/ask-ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_number: row.source_number, question: cleanQuestion, meaning: context.meaning, example: context.daily, note: fields.note.value, video_context: $('#youglish-caption').value.trim(), video_accent: state.youglishAccent.toUpperCase(), history }) });
    const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || 'AI could not answer right now.'); chat.push({ role: 'assistant', content: data.answer });
  } catch (error) { chat.push({ role: 'error', content: error.message }); }
  finally { state.aiBusy = false; renderAiCoach(); }
}

async function render() {
  const row = currentWord(); if (!row) return;
  await refreshWordFromObsidian(row); if (currentWord()?.source_number !== row.source_number) return;
  state.saveGeneration = 0; state.lastSavedGeneration = 0;
  const context = state.contexts[row.word.toLowerCase()] || fallbackContext(row.word);
  $('#source-number').textContent = `#${row.source_number}`; $('#word').textContent = row.word; $('#mastery').textContent = titleCase(row.mastery || 'new');
  $('#meaning').textContent = context.meaning; $('#daily-example').textContent = `“${context.daily}”`; $('#natural-note').textContent = context.natural; $('#scene-note').textContent = context.scene;
  $('#phonetic').textContent = 'Loading pronunciation…'; lookupPhonetic(row.word).then((value) => { if (currentWord()?.source_number === row.source_number) $('#phonetic').textContent = value; });
  Object.entries(fields).forEach(([key, input]) => { input.value = row[key] || ''; });
  $('#note-editor').hidden = true; renderPersonalNote(); setAiPanel(false); renderAiCoach();
  $('#obsidian-path').textContent = row.obsidian_path || `Source Material/Vocabulary/${row.source_number} - ${row.word}.md`;
  $('#save-time').textContent = row.updated_at ? `Last saved ${formatTime(row.updated_at)}` : 'The Markdown file is created after your first note or rating.';
  $('#saved-badge').textContent = row.has_note_file ? 'Saved in Obsidian' : 'Not created yet'; $('#saved-badge').className = 'saved-badge';
  $('#progress-number').textContent = `${state.position + 1} of ${state.session.length}`; $('#progress-fill').style.width = `${((state.position + 1) / state.session.length) * 100}%`;
  $('#playphrase-link').href = `https://www.playphrase.me/#/search?q=${encodeURIComponent(row.word)}`; $('#playphrase-tray-link').href = $('#playphrase-link').href;
  $('#cambridge-link').href = `https://dictionary.cambridge.org/us/dictionary/english/${encodeURIComponent(row.word.replaceAll(' ', '-'))}`;
  $('#previous-word').disabled = state.position === 0; $('#next-word').textContent = state.position === state.session.length - 1 ? 'Finish session ✓' : 'Next word →';
  $('#youglish-consent').hidden = state.youglishEnabled; $('#video-placeholder').hidden = state.youglishEnabled; $('#youglish-experience').hidden = !state.youglishEnabled;
  resetYouglishForWord(row.word);
}

function formatTime(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
function payloadFor(row = currentWord()) { return { source_number: row.source_number, note: fields.note.value, example: fields.example.value, context: fields.context.value, pronunciation_note: fields.pronunciation_note.value }; }
function setSaveState(kind, message) {
  const badge = $('#saved-badge'); badge.className = `saved-badge ${kind || ''}`; badge.textContent = message;
  $('#save-state').innerHTML = `<span class="status-dot"></span> ${message}`;
}
function scheduleSave() { state.saveGeneration += 1; const generation = state.saveGeneration; clearTimeout(state.saveTimer); setSaveState('saving', 'Saving…'); state.saveTimer = setTimeout(() => saveNow(generation), 550); }
async function saveNow(generation = state.saveGeneration) {
  const row = currentWord(); if (!row || generation < state.lastSavedGeneration) return true;
  try {
    const response = await fetch('/api/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payloadFor(row)) }); const data = await response.json();
    if (!response.ok || !data.saved) throw new Error(data.error || 'Save failed'); Object.assign(row, data.word); state.lastSavedGeneration = generation; setSaveState('', 'Saved in Obsidian');
    $('#save-time').textContent = `Saved at ${formatTime(data.word.updated_at)} · atomic write complete`; $('#obsidian-path').textContent = data.word.obsidian_path; renderPersonalNote(); return true;
  } catch (error) { setSaveState('error', 'Not saved — retry'); $('#save-time').textContent = 'Your text is still on screen. Type again to retry.'; toast(error.message); return false; }
}
async function rate(rating) {
  const row = currentWord(); clearTimeout(state.saveTimer); setSaveState('saving', 'Saving review…');
  try {
    const response = await fetch('/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payloadFor(row), rating }) }); const data = await response.json();
    if (!response.ok || !data.saved) throw new Error(data.error || 'Review was not saved'); Object.assign(row, data.word); setSaveState('', 'Review saved');
    if (state.position === state.session.length - 1) finishSession(); else { toast(`Saved · next review ${data.word.next_review}`); moveTo(state.position + 1); }
  } catch (error) { setSaveState('error', 'Review not saved'); toast(error.message); }
}
async function moveTo(position) {
  clearTimeout(state.saveTimer);
  if (state.saveGeneration > state.lastSavedGeneration && !(await saveNow())) return;
  if (position >= state.session.length) { finishSession(); return; }
  state.position = Math.max(0, position); await render(); window.scrollTo({ top: 0, behavior: 'smooth' });
}
function finishSession() {
  if (!state.sessionFinishedAt) state.sessionFinishedAt = Date.now();
  const elapsed = Math.max(1, Math.round((state.sessionFinishedAt - state.sessionStartedAt) / 60000));
  $('#completion-summary').textContent = `${state.session.length} words · ${elapsed} minute${elapsed === 1 ? '' : 's'}`;
  $('#completion-dialog').showModal();
}

function openSettings() {
  $('#daily-count').value = state.dailyCount; $('#ai-provider').value = state.aiSettings.provider || 'openai';
  $('#ai-base-url').value = state.aiSettings.base_url || 'https://api.openai.com/v1'; $('#ai-model').value = state.aiSettings.model || 'gpt-5.6-luna'; $('#ai-token').value = '';
  $('#ai-token').placeholder = state.aiSettings.token_hint ? `${state.aiSettings.token_hint} saved · leave blank to keep it` : 'Paste provider token';
  $('#settings-dialog').showModal();
}
async function saveSettings(event) {
  event.preventDefault(); const button = $('#save-settings'); button.disabled = true; button.textContent = 'Saving…';
  const oldCount = state.dailyCount; const count = Math.min(30, Math.max(3, Number($('#daily-count').value) || 20));
  try {
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: $('#ai-provider').value, api_key: $('#ai-token').value, base_url: $('#ai-base-url').value, model: $('#ai-model').value }) });
    const data = await response.json(); if (!response.ok || !data.saved) throw new Error(data.error || 'Settings were not saved.');
    state.aiSettings = data.settings; state.aiConfigured = Boolean(data.settings.configured); state.aiModel = data.settings.model || '';
    state.dailyCount = count; localStorage.setItem('stella-word-coach-daily-count', String(count));
    if (count !== oldCount) { const currentNumber = currentWord()?.source_number; buildSession(); const found = state.session.findIndex((word) => word.source_number === currentNumber); state.position = found >= 0 ? found : 0; await render(); }
    else renderAiCoach();
    $('#settings-dialog').close(); toast('Settings saved locally.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = 'Save settings'; }
}
async function addWord(event) {
  event.preventDefault(); const submit = event.submitter; if (submit) submit.disabled = true;
  const studyNow = $('#add-to-today').checked;
  try {
    const response = await fetch('/api/add-word', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ word: $('#new-word').value, note: $('#new-word-note').value }) });
    const data = await response.json(); if (!response.ok || !data.saved) throw new Error(data.error || 'Word was not added.');
    let row = state.words.find((word) => word.source_number === data.word.source_number);
    if (!row) { row = data.word; state.words.push(row); } else Object.assign(row, data.word);
    $('#add-word-dialog').close(); event.target.reset(); $('#add-to-today').checked = true;
    if (studyNow && !state.session.some((word) => word.source_number === row.source_number)) state.session.splice(state.position + 1, 0, row);
    if (data.created) toast(`Added “${row.word}” to the CSV${studyNow ? ' and today’s session' : ''}.`); else toast(`“${row.word}” was already in your vocabulary list.`);
    if (studyNow || state.session.some((word) => word.source_number === row.source_number)) await moveTo(state.session.findIndex((word) => word.source_number === row.source_number));
  } catch (error) { toast(error.message); }
  finally { if (submit) submit.disabled = false; }
}

function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); setTimeout(() => element.classList.remove('show'), 3000); }

async function init() {
  try {
    const [wordResponse, contextResponse, settingsResponse] = await Promise.all([fetch('/api/words'), fetch('/api/contexts'), fetch('/api/settings').catch(() => null)]);
    if (!wordResponse.ok || !contextResponse.ok) throw new Error('Could not load vocabulary data.');
    const wordData = await wordResponse.json(); state.words = wordData.words; state.contexts = await contextResponse.json();
    if (settingsResponse?.ok) { state.aiSettings = await settingsResponse.json(); state.aiConfigured = Boolean(state.aiSettings.configured); state.aiModel = state.aiSettings.model || ''; }
    buildSession(); await render();
  } catch (error) { toast(error.message); $('#meaning').textContent = 'The app could not load. Keep start.command open, then refresh.'; }
}

Object.values(fields).forEach((input) => input.addEventListener('input', scheduleSave));
fields.note.addEventListener('input', renderPersonalNote);
$('#speak-word').addEventListener('click', () => speak(currentWord().word, .86)); $('#speak-slow').addEventListener('click', () => speak(currentWord().word, .56));
$('#speak-example').addEventListener('click', () => speak((state.contexts[currentWord().word.toLowerCase()] || fallbackContext(currentWord().word)).daily, .86));
document.querySelectorAll('.rate').forEach((button) => button.addEventListener('click', () => rate(button.dataset.rating)));
$('#next-word').addEventListener('click', () => moveTo(state.position + 1)); $('#previous-word').addEventListener('click', () => moveTo(state.position - 1));
$('#note-add').addEventListener('click', () => setNoteEditor(true)); $('#note-edit').addEventListener('click', () => setNoteEditor(true));
$('#note-cancel').addEventListener('click', () => { clearTimeout(state.saveTimer); fields.note.value = currentWord()?.note || ''; state.saveGeneration = state.lastSavedGeneration; setNoteEditor(false); setSaveState('', currentWord()?.has_note_file ? 'Saved in Obsidian' : 'Obsidian connected'); });
$('#note-done').addEventListener('click', async () => { clearTimeout(state.saveTimer); if (state.saveGeneration > state.lastSavedGeneration && !(await saveNow())) return; setNoteEditor(false); });
$('#ai-toggle').addEventListener('click', () => setAiPanel($('#ai-panel').hidden));
document.querySelectorAll('[data-ai-question]').forEach((button) => button.addEventListener('click', () => { $('#ai-question').value = button.dataset.aiQuestion; $('#ai-question').focus(); }));
$('#ai-form').addEventListener('submit', (event) => { event.preventDefault(); askAi($('#ai-question').value); });
$('#settings-button').addEventListener('click', openSettings); $('#settings-form').addEventListener('submit', saveSettings);
$('#add-word-button').addEventListener('click', () => { $('#add-word-dialog').showModal(); setTimeout(() => $('#new-word').focus(), 50); }); $('#add-word-form').addEventListener('submit', addWord);
document.querySelectorAll('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
$('#backup-button').addEventListener('click', () => { window.location.href = '/api/backup'; });
$('#enable-youglish').addEventListener('click', () => { localStorage.setItem('stella-word-coach-youglish', 'enabled'); state.youglishEnabled = true; loadYouglish(); });
$('#youglish-accent').addEventListener('change', (event) => { state.youglishAccent = event.target.value; resetYouglishForWord(currentWord().word); });
$('#yg-play').addEventListener('click', () => { if (state.youglishWidget) attemptYouglishPlay(); });
$('#yg-previous').addEventListener('click', () => state.youglishWidget?.previous()); $('#yg-replay').addEventListener('click', () => state.youglishWidget?.replay()); $('#yg-speed').addEventListener('click', () => state.youglishWidget?.setSpeed(.75)); $('#yg-next').addEventListener('click', () => state.youglishWidget?.next());
$('#youglish-caption').addEventListener('input', (event) => { state.youglishManualCaption = true; state.youglishCaption = event.target.value; setCaptionDisplay('Manually edited · ready to save'); });
$('#clear-caption').addEventListener('click', () => { state.youglishCaption = ''; state.youglishManualCaption = false; $('#youglish-caption').value = ''; setCaptionDisplay('Cleared · listening for the next caption…'); });
$('#save-caption').addEventListener('click', () => { const caption = $('#youglish-caption').value.trim(); if (!caption || !state.youglishVideoId) return; saveYouglishExample({ caption, video_id: state.youglishVideoId, track_number: state.youglishTrack, accent: state.youglishAccent }); });
$('#ai-provider').addEventListener('change', (event) => { if (event.target.value === 'openai' && !$('#ai-base-url').value.includes('openai.com')) { $('#ai-base-url').value = 'https://api.openai.com/v1'; } });
$('#review-again').addEventListener('click', () => { $('#completion-dialog').close(); state.position = 0; state.sessionStartedAt = Date.now(); state.sessionFinishedAt = null; render(); });
$('#finish-session').addEventListener('click', () => $('#completion-dialog').close());
window.addEventListener('beforeunload', (event) => { if (state.saveGeneration > state.lastSavedGeneration) { navigator.sendBeacon('/api/save', new Blob([JSON.stringify(payloadFor())], { type: 'application/json' })); event.preventDefault(); } });
window.speechSynthesis?.getVoices(); if (state.youglishEnabled) loadYouglish(); init();
