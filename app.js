const OPENAI_BASE       = '/api/chat';  // Secure proxy — key is server-side only
const STORAGE_KEY_MODEL = 'aptiq_model';
const STORAGE_KEY_STYLE = 'aptiq_style';

const MAX_RETRIES  = 3;
const RETRY_DELAY  = 2000;

let state = {
  apiKey: '',  // Not needed — handled securely by server proxy
  model:  localStorage.getItem(STORAGE_KEY_MODEL) || 'gpt-4o-mini',
  style:  localStorage.getItem(STORAGE_KEY_STYLE) || 'balanced',
  images: [],
  history: [],   // conversation history sent to OpenAI [{role, content}]
};

const $ = id => document.getElementById(id);

// ---- INIT ----
document.addEventListener('DOMContentLoaded', () => {
  $('api-key-input').value = state.apiKey;
  $('model-select').value  = state.model;
  const styleEl = document.querySelector(`input[name="style"][value="${state.style}"]`);
  if (styleEl) styleEl.checked = true;
  setupEvents();
});

// ---- EVENTS ----
function setupEvents() {
  $('new-chat-btn').addEventListener('click', newChat);
  $('settings-btn').addEventListener('click', () => $('settings-overlay').style.display = 'flex');
  $('close-settings').addEventListener('click', () => $('settings-overlay').style.display = 'none');
  $('settings-overlay').addEventListener('click', e => {
    if (e.target === $('settings-overlay')) $('settings-overlay').style.display = 'none';
  });

  $('save-key-btn').addEventListener('click', saveApiKey);
  $('test-key-btn').addEventListener('click', testApiKey);
  $('toggle-pw').addEventListener('click', () => {
    const inp = $('api-key-input');
    const show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('toggle-pw').textContent = show ? 'Hide' : 'Show';
  });
  $('save-model-btn').addEventListener('click', () => {
    state.model = $('model-select').value;
    localStorage.setItem(STORAGE_KEY_MODEL, state.model);
    showToast('Model saved');
  });
  $('save-style-btn').addEventListener('click', () => {
    const el = document.querySelector('input[name="style"]:checked');
    if (el) { state.style = el.value; localStorage.setItem(STORAGE_KEY_STYLE, el.value); showToast('Style saved'); }
  });

  $('file-input').addEventListener('change', e => {
    processFiles(Array.from(e.target.files));
    e.target.value = '';
  });
  document.addEventListener('paste', handlePaste);

  $('question-input').addEventListener('input', () => {
    autoResize($('question-input'));
    toggleSend();
  });
  $('question-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  $('send-btn').addEventListener('click', handleSend);

  // Auto-focus textarea on any printable key press (like ChatGPT)
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const inInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    const isModifier = e.ctrlKey || e.metaKey || e.altKey;
    const isPrintable = e.key.length === 1 && !isModifier;

    if (isPrintable && !inInput) {
      const input = $('question-input');
      input.focus();
      // Let the key naturally type into the box (don't preventDefault)
    }
  });
}

// ---- HELPERS ----
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}
function toggleSend() {
  $('send-btn').disabled = !$('question-input').value.trim() && state.images.length === 0;
}
function newChat() {
  state.images  = [];
  state.history = [];   // clear conversation context
  $('img-strip').innerHTML = '';
  $('messages').innerHTML  = '';
  $('question-input').value = '';
  $('question-input').style.height = 'auto';
  $('welcome').style.display = '';
  toggleSend();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const MAX_IMAGES   = 10;

// ---- IMAGE HANDLING ----
function handlePaste(e) {
  const imgs = Array.from(e.clipboardData?.items || [])
    .filter(i => i.type.startsWith('image/'))
    .map(i => i.getAsFile());
  if (imgs.length) { processFiles(imgs); showToast('Screenshot pasted'); }
}
function processFiles(files) {
  const slots = MAX_IMAGES - state.images.length;
  if (slots <= 0) { showToast(`⚠️ Max ${MAX_IMAGES} images per message`); return; }

  const toAdd = Array.from(files).filter(f => f?.type.startsWith('image/')).slice(0, slots);
  if (toAdd.length < files.length) showToast(`⚠️ Only ${slots} more image(s) allowed (max ${MAX_IMAGES})`);

  toAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = e => {
      state.images.push({ dataUrl: e.target.result, mimeType: file.type });
      renderStrip();
      toggleSend();
    };
    reader.readAsDataURL(file);
  });
}
function renderStrip() {
  $('img-strip').innerHTML = state.images.map((img, i) => `
    <div class="strip-img-wrap">
      <img class="strip-img" src="${img.dataUrl}" alt="img ${i+1}" />
      <button class="strip-remove" data-i="${i}">✕</button>
    </div>
  `).join('');
  $('img-strip').querySelectorAll('.strip-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      state.images.splice(+btn.dataset.i, 1);
      renderStrip();
      toggleSend();
    });
  });
}

// ---- SEND ----
async function handleSend() {
  if (!state.apiKey) {
    showToast('⚠️ Paste your OpenAI key in Settings first');
    $('settings-overlay').style.display = 'flex';
    return;
  }
  const question = $('question-input').value.trim();
  if (!question && state.images.length === 0) return;

  const sentImages = [...state.images];
  state.images = [];
  $('img-strip').innerHTML = '';
  $('question-input').value = '';
  $('question-input').style.height = 'auto';
  $('send-btn').disabled = true;

  $('welcome').style.display = 'none';
  appendMessage('user', question, sentImages);
  scrollBottom();

  const typId = 'typ-' + Date.now();
  appendTyping(typId);
  scrollBottom();

  try {
    const answer = await callOpenAIWithRetry(question, sentImages, typId);
    removeEl(typId);
    appendMessage('ai', answer);
  } catch (err) {
    removeEl(typId);
    appendMessage('ai', `**Error:** ${err.message}`);
  }
  scrollBottom();
}

// ---- OPENAI API WITH RETRY ----
async function callOpenAIWithRetry(question, images, typId) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      updateTypingStatus(typId,
        attempt === 1 ? 'Thinking…' : `Retrying… (${attempt}/${MAX_RETRIES})`
      );
      return await callOpenAI(question, images);
    } catch (err) {
      const retryable = /429|rate.?limit|overload|503|502|500|timeout|network|EOF/i.test(err.message);
      if (retryable && attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY * attempt;
        updateTypingStatus(typId, `Busy, waiting ${delay/1000}s then retrying…`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

async function callOpenAI(question, images) {
  const isVisionModel = !state.model.includes('3.5');

  // Build current user message content
  let userContent;
  if (images.length > 0 && isVisionModel) {
    userContent = [
      ...images.map(img => ({
        type: 'image_url',
        image_url: { url: img.dataUrl, detail: 'high' },
      })),
      { type: 'text', text: question || 'Analyze the question in the image and provide a complete answer.' },
    ];
  } else {
    userContent = question || 'Analyze the question in the image.';
  }

  // Add this user message to history
  state.history.push({ role: 'user', content: userContent });

  // Keep last 20 messages to stay within token limits
  const trimmedHistory = state.history.slice(-20);

  const res = await fetch(OPENAI_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: state.model,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        ...trimmedHistory,   // full conversation context
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    // Remove the failed user message from history
    state.history.pop();
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${res.status} — check your API key or billing`);
  }

  const data = await res.json();
  const txt = data?.choices?.[0]?.message?.content;
  if (!txt) throw new Error('Empty response. Try again.');

  // Save assistant reply to history
  state.history.push({ role: 'assistant', content: txt });
  return txt;
}

function buildSystemPrompt() {
  const styleGuide = {
    concise:  'Be very concise. For MCQs state the answer letter + one-line reason. For code give working code only.',
    balanced: 'Give the answer with a clear explanation. For MCQs identify the correct option and explain why in 2–4 lines. For code provide working code with brief comments.',
    detailed: 'Give a thorough explanation. For MCQs explain all options. For code provide well-commented code, time/space complexity, and edge cases.',
  };
  return `You are AptIQ, an expert AI assistant for students and developers.
Auto-detect the question type (Aptitude MCQ, Python, Coding, SQL, Web Development, DSA, or General) and respond accordingly.
- ${styleGuide[state.style] || styleGuide.balanced}
- Use Markdown: **bold**, \`inline code\`, fenced code blocks (\`\`\`language), lists, tables.
- For MCQs: start with "**Answer: [Option]**" clearly at the top.
- For code: always use a fenced code block with the correct language tag.
- Be accurate and helpful.`;
}

// ---- SETTINGS ----
function saveApiKey() {
  const key = $('api-key-input').value.trim();
  state.apiKey = key;
  localStorage.setItem(STORAGE_KEY_API, key);
  showToast('✅ API key saved');
  $('key-status').innerHTML = '<span style="color:#34d399">✅ Saved!</span>';
}

async function testApiKey() {
  const key = $('api-key-input').value.trim();
  if (!key) { $('key-status').innerHTML = '<span style="color:#f87171">Enter a key first</span>'; return; }
  $('key-status').innerHTML = '<span style="color:#aaa">Testing…</span>';
  $('test-key-btn').disabled = true;
  try {
    const res = await fetch(OPENAI_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: $('model-select').value,
        messages: [{ role: 'user', content: 'Say OK.' }],
        max_tokens: 5,
      }),
    });
    if (res.ok) {
      $('key-status').innerHTML = '<span style="color:#34d399">✅ Connected! Key works.</span>';
      state.apiKey = key;
      localStorage.setItem(STORAGE_KEY_API, key);
    } else {
      const e = await res.json().catch(() => ({}));
      $('key-status').innerHTML = `<span style="color:#f87171">❌ ${esc(e?.error?.message || 'Invalid key')}</span>`;
    }
  } catch (e) {
    $('key-status').innerHTML = `<span style="color:#f87171">❌ ${esc(e.message)}</span>`;
  } finally {
    $('test-key-btn').disabled = false;
  }
}

// ---- RENDER MESSAGES ----
function appendMessage(role, text, images = []) {
  const msgs = $('messages');
  const div = document.createElement('div');
  div.className = `msg ${role}`;

  const imgHtml = images.length
    ? `<div class="msg-images">${images.map((img, i) =>
        `<img class="msg-img" src="${img.dataUrl}" alt="img${i+1}" />`).join('')}</div>`
    : '';

  const actions = role === 'ai'
    ? `<div class="msg-actions">
        <button class="copy-btn" type="button">
          <svg viewBox="0 0 20 20" fill="currentColor" width="12" height="12">
            <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"/>
            <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"/>
          </svg>Copy
        </button>
      </div>`
    : '';

  div.innerHTML = `
    <div class="msg-avatar">${role === 'user' ? 'U' : '✦'}</div>
    <div class="msg-content">
      <div class="msg-label">${role === 'user' ? 'You' : 'AptIQ'}</div>
      ${imgHtml}
      <div class="msg-body">${markdownToHtml(text)}</div>
      ${actions}
    </div>
  `;

  div.querySelector('.copy-btn')?.addEventListener('click', () => {
    navigator.clipboard.writeText(div.querySelector('.msg-body').innerText).then(() => showToast('Copied'));
  });
  div.querySelectorAll('.copy-code-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      navigator.clipboard.writeText(btn.closest('pre')?.querySelector('code')?.innerText || '').then(() => showToast('Code copied'));
    });
  });
  div.querySelectorAll('.msg-img').forEach(img => {
    img.addEventListener('click', () => window.open(img.src, '_blank'));
  });

  msgs.appendChild(div);
}

function appendTyping(id) {
  const div = document.createElement('div');
  div.id = id;
  div.className = 'msg ai typing-msg';
  div.innerHTML = `
    <div class="msg-avatar">✦</div>
    <div class="msg-content">
      <div class="msg-label">AptIQ</div>
      <div class="msg-body">
        <div class="typing-inner">
          <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          <span class="typing-status" id="${id}-status">Thinking…</span>
        </div>
      </div>
    </div>
  `;
  $('messages').appendChild(div);
}

function updateTypingStatus(id, text) {
  const el = document.getElementById(`${id}-status`);
  if (el) el.textContent = text;
}
function removeEl(id) { document.getElementById(id)?.remove(); }
function scrollBottom() { const ca = $('chat-area'); ca.scrollTop = ca.scrollHeight; }

// ---- MARKDOWN ----
function markdownToHtml(md) {
  if (!md) return '';
  const codeBlocks = [];
  let html = md.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang.trim() || 'code', code });
    return `%%CB${codeBlocks.length - 1}%%`;
  });
  const inlines = [];
  html = html.replace(/`([^`]+)`/g, (_, c) => { inlines.push(c); return `%%IC${inlines.length - 1}%%`; });
  html = esc(html);
  html = html.replace(/^######\s+(.+)$/gm, '<h6>$1</h6>');
  html = html.replace(/^#####\s+(.+)$/gm,  '<h5>$1</h5>');
  html = html.replace(/^####\s+(.+)$/gm,   '<h4>$1</h4>');
  html = html.replace(/^###\s+(.+)$/gm,    '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm,     '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm,      '<h1>$1</h1>');
  html = html.replace(/^&gt;\s+(.+)$/gm,   '<blockquote>$1</blockquote>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g,         '<em>$1</em>');
  html = html.replace(/__(.+?)__/g,         '<strong>$1</strong>');
  html = html.replace(/^---$/gm,            '<hr>');
  html = html.replace(/^(\|.+\|\n)+/gm, tbl => {
    const rows = tbl.trim().split('\n').filter(r => !/^\|[\s\-:|]+\|$/.test(r));
    if (!rows.length) return tbl;
    const head = rows.shift().split('|').filter(Boolean).map(h => `<th>${h.trim()}</th>`).join('');
    const body = rows.map(r => `<tr>${r.split('|').filter(Boolean).map(c => `<td>${c.trim()}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  });
  html = html.replace(/(^[-*+]\s.+\n?)+/gm, b =>
    `<ul>${b.trim().split('\n').map(l => `<li>${l.replace(/^[-*+]\s/, '').trim()}</li>`).join('')}</ul>`);
  html = html.replace(/(^\d+\.\s.+\n?)+/gm, b =>
    `<ol>${b.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s/, '').trim()}</li>`).join('')}</ol>`);
  html = html.replace(/\n{2,}/g, '\n</p><p>\n');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*(<(?:h[1-6]|ul|ol|table|blockquote|hr)[^>]*>)/g, '$1');
  html = html.replace(/(<\/(?:h[1-6]|ul|ol|table|blockquote|hr)>)\s*<\/p>/g, '$1');
  html = html.replace(/([^>])\n([^<])/g, '$1<br>$2');
  inlines.forEach((c, i) => { html = html.replace(`%%IC${i}%%`, `<code>${esc(c)}</code>`); });
  codeBlocks.forEach((b, i) => {
    html = html.replace(`%%CB${i}%%`,
      `<pre><div class="code-header"><span class="code-lang">${b.lang}</span><button class="copy-code-btn" type="button">Copy</button></div><code class="language-${b.lang}">${esc(b.code.trimEnd())}</code></pre>`
    );
  });
  return html;
}

// ---- UTILS ----
function showToast(msg, ms = 2500) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
