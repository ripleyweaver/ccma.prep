// ============================================================
// CCMA Prep - app.js
// Quiz engine, domain weighting, randomization, localStorage
// ============================================================

const EXAM_DATE = new Date('2026-07-28T00:00:00');
const APP_VERSION = '1.0.1'; // 1.0.0 = first full release with final question bank.

// ============================================================
// UNLOAD PROTECTION
// Warns the person if they try to close the tab, refresh, or
// navigate away while a quiz is actively in progress. Quitting
// or finishing the quiz normally clears this warning.
// ============================================================
let unloadProtectionActive = false;

function setUnloadProtection(active) {
  unloadProtectionActive = active;
}

window.addEventListener('beforeunload', (e) => {
  if (unloadProtectionActive) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Domain metadata: internal key -> official NHA display name + exam weight (out of 150)
// Names match the 2022 CCMA Test Plan exactly. Order here is NOT exam-weight order.
const DOMAINS = {
  domain01: { name: 'Foundational Knowledge and Basic Science', weight: 15 },
  domain02: { name: 'Anatomy and Physiology', weight: 8 },
  domain03: { name: 'Clinical Patient Care', weight: 84 },
  domain04: { name: 'Patient Care Coordination and Education', weight: 12 },
  domain05: { name: 'Administrative Assisting', weight: 12 },
  domain06: { name: 'Communication and Customer Service', weight: 12 },
  domain07: { name: 'Medical Law and Ethics', weight: 7 }
};

// Pre-computed weighted question counts per quiz length (locked-in spec)
const WEIGHTED_COUNTS = {
  25: { domain01: 3, domain02: 1, domain03: 14, domain04: 2, domain05: 2, domain06: 2, domain07: 1 },
  100: { domain01: 10, domain02: 5, domain03: 56, domain04: 8, domain05: 8, domain06: 8, domain07: 5 }
};

// Domains sorted by exam weight, descending, for display purposes (no numbers shown)
const DOMAIN_DISPLAY_ORDER = Object.keys(DOMAINS).sort((a, b) => DOMAINS[b].weight - DOMAINS[a].weight);

let QUESTIONS = {}; // loaded from questions.json
let currentQuiz = null; // active quiz state

// ============================================================
// STORAGE KEYS
// ============================================================
const STORAGE_KEYS = {
  attempts: 'ccma_attempts',           // array of attempt records
  domainStats: 'ccma_domain_stats',    // { domainKey: { correct, total } }
  missedPool: 'ccma_missed_pool',      // array of question IDs currently in missed pool
  missedRecovery: 'ccma_missed_recovery', // { questionId: correctCountWhileInMissed }
  answeredCorrectly: 'ccma_answered_correctly' // set of question IDs ever answered correctly
};

function getStorage(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function setStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error('Storage error', e);
  }
}

// ============================================================
// INITIALIZATION
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  setAppState('loading');
  loadQuestions();
  applyInitialTheme();
  updateCountdown();
  registerServiceWorker();
  const versionEl = document.getElementById('app-version');
  if (versionEl) versionEl.textContent = `v${APP_VERSION}`;
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.error('Service worker registration failed:', err);
    });
  });
}

const KNOWN_DOMAIN_KEYS = new Set(['domain01','domain02','domain03','domain04','domain05','domain06','domain07','terminology']);
const REQUIRED_QUESTION_FIELDS = ['id','question','choices','correctIndex','explanation'];

function validateQuestions(data) {
  const errors = [];
  const seenIds = new Set();

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    errors.push('questions.json must be a JSON object with domain keys at the top level');
    return errors;
  }

  Object.keys(data).forEach(domKey => {
    if (!KNOWN_DOMAIN_KEYS.has(domKey)) {
      errors.push(`Unknown domain key: "${domKey}" — expected one of ${[...KNOWN_DOMAIN_KEYS].join(', ')}`);
    }
    const questions = data[domKey];
    if (!Array.isArray(questions)) {
      errors.push(`Domain "${domKey}" must be an array`);
      return;
    }
    questions.forEach((q, i) => {
      const ref = `${domKey}[${i}]`;

      // Required fields present
      REQUIRED_QUESTION_FIELDS.forEach(field => {
        if (q[field] === undefined || q[field] === null) {
          errors.push(`${ref}: missing required field "${field}"`);
        }
      });

      // id: non-empty string, globally unique
      if (typeof q.id !== 'string' || q.id.trim() === '') {
        errors.push(`${ref}: "id" must be a non-empty string`);
      } else if (seenIds.has(q.id)) {
        errors.push(`${ref}: duplicate id "${q.id}"`);
      } else {
        seenIds.add(q.id);
      }

      // question: non-empty string
      if (typeof q.question !== 'string' || q.question.trim() === '') {
        errors.push(`${ref}: "question" must be a non-empty string`);
      }

      // choices: array with at least 2 items
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        errors.push(`${ref}: "choices" must be an array with at least 2 items (got ${Array.isArray(q.choices) ? q.choices.length : typeof q.choices})`);
      } else if (q.choices.length < 4) {
        console.warn(`${ref}: "choices" has only ${q.choices.length} items (prefer 4 for exam parity)`);
      }

      // correctIndex: valid index inside choices
      if (Array.isArray(q.choices) && (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex >= q.choices.length)) {
        errors.push(`${ref}: "correctIndex" (${q.correctIndex}) is out of range for choices array (length ${q.choices.length})`);
      }

      // explanation: non-empty string
      if (typeof q.explanation !== 'string' || q.explanation.trim() === '') {
        errors.push(`${ref}: "explanation" must be a non-empty string`);
      }
    });
  });

  return errors;
}

function loadQuestions(attempt = 1) {
  const maxAttempts = 3;
  fetch('questions.json', { cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error(`Server responded with ${res.status}`);
      return res.json();
    })
    .then(data => {
      const errors = validateQuestions(data);
      if (errors.length > 0) {
        console.error(`questions.json validation failed (${errors.length} error${errors.length === 1 ? '' : 's'}):`);
        errors.forEach(e => console.error(' •', e));
        setAppState('error');
        return;
      }
      QUESTIONS = data;
      setAppState('ready');
    })
    .catch(err => {
      console.error(`Failed to load questions.json (attempt ${attempt})`, err);
      if (attempt < maxAttempts) {
        // Transient failures (a dropped connection, a service worker race
        // during install, a slow network) are common and usually resolve
        // themselves a moment later. Retry a couple of times with a short
        // delay before giving up and showing the permanent error banner.
        setTimeout(() => loadQuestions(attempt + 1), attempt * 800);
      } else {
        setAppState('error');
      }
    });
}

// Three states: 'loading' (disable quiz buttons, show subtle hint),
// 'ready' (normal use), 'error' (fetch failed, show retry banner).
function setAppState(state) {
  const errorBanner = document.getElementById('load-error-banner');
  const emptyBanner = document.getElementById('empty-bank-banner');

  if (errorBanner) errorBanner.style.display = (state === 'error') ? 'block' : 'none';

  if (state !== 'ready') {
    // Loading or error: disable everything
    document.querySelectorAll('.quiz-row').forEach(btn => { btn.disabled = true; });
    if (emptyBanner) emptyBanner.style.display = 'none';
    return;
  }

  // State is 'ready' — enable/disable per-quiz-type based on available questions
  const totalQuestions = Object.values(QUESTIONS).reduce((sum, arr) => sum + arr.length, 0);
  const hasPractice = Object.keys(DOMAINS).some(k => (QUESTIONS[k] || []).length > 0);
  const hasTerminology = (QUESTIONS.terminology || []).length > 0;
  const hasDomain = hasPractice; // domain picker guards per-domain internally

  // The practice and terminology rows are the first two .quiz-row elements
  const [practiceBtn, terminologyBtn, domainBtn] = document.querySelectorAll('.quiz-row');
  if (practiceBtn) practiceBtn.disabled = !hasPractice;
  if (terminologyBtn) terminologyBtn.disabled = !hasTerminology;
  if (domainBtn) domainBtn.disabled = !hasDomain;

  if (emptyBanner) emptyBanner.style.display = (totalQuestions === 0) ? 'block' : 'none';

  // Missed Questions has its own separate unlock logic
  updateMissedButtonState();
}

function retryLoadQuestions() {
  setAppState('loading');
  loadQuestions();
}

// ============================================================
// THEME
// ============================================================
function applyInitialTheme() {
  // Always check the device preference fresh on load. There is no
  // persisted "last manual choice" across reloads by design: the person's
  // chosen theme for this visit only lasts until they reload or revisit.
  const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
  const initialMode = prefersLight ? 'light' : 'dark';
  applyThemeMode(initialMode);
}

function cycleThemeMode() {
  const current = document.body.classList.contains('light') ? 'light' : 'dark';
  const nextMode = current === 'light' ? 'dark' : 'light';
  applyThemeMode(nextMode);
}

function applyThemeMode(mode) {
  setBodyTheme(mode);
  updateThemeSwitcherUI(mode);
}

const THEME_COLORS = { light: '#F7F4EF', dark: '#1A1A1A' };

function setBodyTheme(resolved) {
  document.body.classList.toggle('light', resolved === 'light');
  document.body.classList.toggle('dark', resolved === 'dark');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLORS[resolved] || THEME_COLORS.dark);
}

const THEME_DISPLAY_NAMES = { light: 'Light', dark: 'Dark' };
const THEME_ICONS = { light: '☀️', dark: '🌙' };

function updateThemeSwitcherUI(mode) {
  const btn = document.getElementById('theme-switcher');
  const icon = document.getElementById('theme-switcher-icon');
  const displayName = THEME_DISPLAY_NAMES[mode] || 'Dark';
  if (icon) icon.textContent = THEME_ICONS[mode] || THEME_ICONS.dark;
  if (btn) {
    btn.setAttribute('aria-label', `Theme: ${displayName}`);
    btn.setAttribute('title', `Theme: ${displayName}`);
  }
}
// ============================================================
// COUNTDOWN
// ============================================================
function updateCountdown() {
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil((EXAM_DATE - now) / msPerDay);
  document.getElementById('countdown-number').textContent = daysLeft >= 0 ? daysLeft : 0;
}

// ============================================================
// SCREEN NAVIGATION
// ============================================================
const SCREEN_HEADING_IDS = {
  'length-picker': 'length-picker-title',
  'domain-picker': 'domain-picker-title',
  'quiz': 'quiz-screen-heading'
  // 'home' and 'progress' fall back to the generic h1/h2 lookup below
};

// .screen is the real scroll container on phones/PWA (html/body are locked
// with overflow: hidden), so scrolling must target the active screen element
// itself rather than window.
function scrollScreenToTop(screenEl) {
  if (!screenEl) return;
  screenEl.scrollTop = 0;
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screenEl = document.getElementById('screen-' + name);
  screenEl.classList.add('active');

  scrollScreenToTop(screenEl);

  if (name === 'progress') renderProgressScreen();

  // Move focus to the new screen's heading so keyboard and screen-reader
  // users get a clear signal that the screen changed, not just sighted users.
  // preventScroll avoids the focus call itself re-triggering a scroll that
  // would fight with scrollScreenToTop above.
  const headingId = SCREEN_HEADING_IDS[name];
  const heading = headingId ? document.getElementById(headingId) : screenEl.querySelector('h1, h2');
  if (heading) heading.focus({ preventScroll: true });
}

// ============================================================
// MISSED QUESTIONS UNLOCK STATE
// ============================================================

// Return all question IDs currently in the bank, for stale-ID filtering.
function getAllQuestionIds() {
  const ids = new Set();
  Object.values(QUESTIONS).forEach(arr => arr.forEach(q => ids.add(q.id)));
  return ids;
}

function updateMissedButtonState() {
  const existingIds = getAllQuestionIds();
  const rawMissed = getStorage(STORAGE_KEYS.missedPool, []);
  // Filter out any IDs that no longer exist in the current question bank
  const liveMissed = rawMissed.filter(id => existingIds.has(id));

  const btn = document.getElementById('missed-btn');
  const sub = document.getElementById('missed-sub');
  const missedCount = liveMissed.length;

  if (missedCount === 0) {
    btn.classList.add('locked');
    btn.disabled = true;
    sub.textContent = 'No missed questions right now';
  } else {
    btn.classList.remove('locked');
    btn.disabled = false;
    sub.textContent = `Drill your weak spots (${missedCount} question${missedCount === 1 ? '' : 's'})`;
  }
}

// ============================================================
// DOMAIN PICKER SCREEN
// ============================================================
let selectedStudyDomain = null;
let selectedStudyLength = 25;

function renderDomainPicker() {
  const list = document.getElementById('domain-pick-list');
  list.innerHTML = '';

  // Reset start button — user must pick a non-empty domain
  selectedStudyDomain = null;
  document.getElementById('domain-start-btn').disabled = true;

  DOMAIN_DISPLAY_ORDER.forEach(key => {
    const count = (QUESTIONS[key] || []).length;
    const div = document.createElement('div');
    div.className = 'domain-pick' + (count === 0 ? ' empty-domain' : '');
    div.textContent = DOMAINS[key].name + (count === 0 ? ' — no questions yet' : '');
    if (count > 0) {
      div.onclick = () => selectStudyDomain(key, div);
    }
    list.appendChild(div);
  });
}

function selectStudyDomain(key, el) {
  selectedStudyDomain = key;
  document.querySelectorAll('.domain-pick').forEach(d => d.classList.remove('selected'));
  el.classList.add('selected');
  document.getElementById('domain-start-btn').disabled = false;
}

function selectLength(len, el) {
  selectedStudyLength = len;
  document.querySelectorAll('.length-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

function startDomainQuiz() {
  if (!selectedStudyDomain) return;
  buildQuiz('domain', selectedStudyLength, selectedStudyDomain);
}

// Render picker whenever the user navigates to it
const originalShowScreen = showScreen;
showScreen = function(name) {
  originalShowScreen(name);
  if (name === 'domain-picker') renderDomainPicker();
};

// ============================================================
// GENERIC LENGTH PICKER (Practice / Terminology / Missed)
// ============================================================
let pendingQuizType = null;
let pendingQuizLength = 25;

function openLengthPicker(type, title) {
  pendingQuizType = type;
  pendingQuizLength = 25;
  document.getElementById('length-picker-title').textContent = title;
  // Reset button selection state
  showScreen('length-picker');
  const lengthBtns = document.querySelectorAll('#screen-length-picker .length-btn');
  lengthBtns.forEach(b => b.classList.toggle('selected', b.dataset.length === '25'));
  updateLengthPickerSub();
}

function startMissedQuiz() {
  const missedCount = getStorage(STORAGE_KEYS.missedPool, []).length;
  if (missedCount === 0) return; // locked, nothing to drill yet
  const length = Math.min(missedCount, 25);
  buildQuiz('missed', length, null);
}

function updateLengthPickerSub() {
  const subEl = document.getElementById('length-picker-sub');
  subEl.textContent = 'Randomized every session, weighted to the real exam.';
}

function selectGenericLength(len, el) {
  pendingQuizLength = len;
  document.querySelectorAll('#screen-length-picker .length-btn').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

function startGenericQuiz() {
  buildQuiz(pendingQuizType, pendingQuizLength, null);
}

// ============================================================
// QUIZ BUILDING - weighting, backfill, randomization
// ============================================================
function buildQuiz(type, length, domainKey) {
  let pool = [];
  const existingIds = getAllQuestionIds();

  if (type === 'domain') {
    const src = domainKey === 'terminology' ? (QUESTIONS.terminology || []) : (QUESTIONS[domainKey] || []);
    if (src.length === 0) {
      alert('No questions available for this domain yet.');
      return;
    }
    pool = shuffle([...src]).slice(0, length).map(q => ({ ...q, sourceDomain: domainKey }));
  } else if (type === 'terminology') {
    const src = QUESTIONS.terminology || [];
    if (src.length === 0) {
      alert('No terminology questions available yet.');
      return;
    }
    pool = shuffle([...src]).slice(0, length).map(q => ({ ...q, sourceDomain: 'terminology' }));
  } else if (type === 'practice') {
    pool = buildWeightedPool(length);
    if (pool.length === 0) {
      alert('No questions available yet. Add questions to begin studying.');
      return;
    }
  } else if (type === 'missed') {
    const rawMissed = getStorage(STORAGE_KEYS.missedPool, []);
    // Filter stale IDs that no longer exist in the current bank
    const liveMissedIds = rawMissed.filter(id => existingIds.has(id));
    if (liveMissedIds.length === 0) return;
    let missedQuestions = [];
    Object.keys(QUESTIONS).forEach(domKey => {
      QUESTIONS[domKey].forEach(q => {
        if (liveMissedIds.includes(q.id)) missedQuestions.push({ ...q, sourceDomain: domKey });
      });
    });
    pool = shuffle(missedQuestions).slice(0, length);
  }

  if (pool.length === 0) return;

  // Shuffle each question's answer choices so correct answer position varies
  pool = pool.map(q => shuffleChoices(q));

  currentQuiz = {
    type, length: pool.length, domainKey,
    questions: pool,
    currentIndex: 0,
    answers: [], // { questionId, correct, sourceDomain }
    answeredCurrent: false
  };

  setUnloadProtection(true);
  showScreen('quiz');
  renderQuizQuestion();
}

// Build a weighted pool for Practice quiz with 3-tier backfill
function buildWeightedPool(length) {
  const counts = WEIGHTED_COUNTS[length] || WEIGHTED_COUNTS[25];
  const answeredCorrectly = new Set(getStorage(STORAGE_KEYS.answeredCorrectly, []));
  let pool = [];
  let usedIds = new Set();

  // Tier 1: pull weighted count from each domain's own pool
  Object.keys(counts).forEach(domKey => {
    const need = counts[domKey];
    const available = shuffle([...(QUESTIONS[domKey] || [])]);
    let taken = 0;
    for (const q of available) {
      if (taken >= need) break;
      if (!usedIds.has(q.id)) {
        pool.push({ ...q, sourceDomain: domKey });
        usedIds.add(q.id);
        taken++;
      }
    }
    // Tier 2: backfill from anywhere unanswered-correctly if this domain came up short
    if (taken < need) {
      const shortfall = need - taken;
      const allUnanswered = [];
      Object.keys(QUESTIONS).forEach(dk => {
        QUESTIONS[dk].forEach(q => {
          if (!usedIds.has(q.id) && !answeredCorrectly.has(q.id)) {
            allUnanswered.push({ ...q, sourceDomain: dk });
          }
        });
      });
      const backfill = shuffle(allUnanswered).slice(0, shortfall);
      backfill.forEach(q => { pool.push(q); usedIds.add(q.id); });
    }
  });

  // Tier 3: if total pool is still short of `length` (extreme mastery case), reuse mastered questions
  if (pool.length < length) {
    const shortfall = length - pool.length;
    const allMastered = [];
    Object.keys(QUESTIONS).forEach(dk => {
      QUESTIONS[dk].forEach(q => {
        if (!usedIds.has(q.id)) allMastered.push({ ...q, sourceDomain: dk });
      });
    });
    const backfill = shuffle(allMastered).slice(0, shortfall);
    backfill.forEach(q => { pool.push(q); usedIds.add(q.id); });
  }

  return shuffle(pool).slice(0, length);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function shuffleChoices(question) {
  // Pair each choice with its original index, shuffle the pairs together,
  // then recover the new correct index. This avoids matching by text content,
  // which would silently misidentify the correct answer if two choices ever
  // had identical text.
  const paired = question.choices.map((text, i) => ({ text, wasCorrect: i === question.correctIndex }));
  const shuffledPairs = shuffle(paired);
  const newCorrectIndex = shuffledPairs.findIndex(p => p.wasCorrect);
  return { ...question, choices: shuffledPairs.map(p => p.text), correctIndex: newCorrectIndex };
}

// ============================================================
// QUIZ RENDERING
// ============================================================
function renderQuizQuestion() {
  const quizScreen = document.getElementById('screen-quiz');
  scrollScreenToTop(quizScreen);

  const q = currentQuiz.questions[currentQuiz.currentIndex];
  const total = currentQuiz.questions.length;
  const idx = currentQuiz.currentIndex + 1;

  document.getElementById('quiz-progress-text').textContent = `${String(idx).padStart(2, '0')} / ${total}`;
  document.getElementById('quiz-progress-fill').style.transform = `scaleX(${idx / total})`;
  document.getElementById('quiz-domain-label').textContent = getDomainDisplayName(q.sourceDomain);
  document.getElementById('quiz-question-text').textContent = q.question;

  const choicesContainer = document.getElementById('quiz-choices');
  choicesContainer.innerHTML = '';
  q.choices.forEach((choiceText, i) => {
    const btn = document.createElement('button');
    btn.className = 'choice';
    btn.innerHTML = `
      <span class="choice-row">
        <span class="choice-content">
          <span class="choice-txt">${escapeHtml(choiceText)}</span>
        </span>
        <span class="choice-icon" aria-hidden="true"></span>
      </span>
    `;
    btn.onclick = () => selectAnswer(i);
    choicesContainer.appendChild(btn);
  });

  document.getElementById('quiz-next-btn').style.display = 'none';
  currentQuiz.answeredCurrent = false;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getDomainDisplayName(key) {
  if (key === 'terminology') return 'Terminology';
  return DOMAINS[key] ? DOMAINS[key].name : key;
}

function selectAnswer(choiceIndex) {
  if (currentQuiz.answeredCurrent) return; // prevent double answer
  currentQuiz.answeredCurrent = true;

  const q = currentQuiz.questions[currentQuiz.currentIndex];
  const isCorrect = choiceIndex === q.correctIndex;

  const buttons = document.querySelectorAll('#quiz-choices .choice');
  buttons.forEach((btn, i) => {
    btn.disabled = true;
    const iconEl = btn.querySelector('.choice-icon');
    if (i === q.correctIndex) {
      btn.classList.add('correct');
      iconEl.textContent = 'Correct';
      // Inline collapsible explanation lives inside the correct answer's card.
      // The whole card stays clickable to toggle it, since a small text link
      // is an easy-to-miss tap target on mobile.
      btn.disabled = false;
      btn.classList.add('explanation-host');
      const toggleId = 'quiz-explanation-toggle';
      const boxId = 'quiz-explanation-box';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'explanation-toggle';
      toggle.id = toggleId;
      toggle.innerHTML = 'Show Explanation <span class="chevron">⌄</span>';
      toggle.tabIndex = -1; // card itself handles the tap; avoid double focus stops
      const box = document.createElement('div');
      box.className = 'explanation-box';
      box.id = boxId;
      box.style.display = 'none';
      box.textContent = q.explanation;
      // Appended directly to the button, full width, not nested inside the
      // flex row that shares space with the "Correct" label
      btn.appendChild(toggle);
      btn.appendChild(box);
      btn.onclick = (e) => {
        e.preventDefault();
        toggleExplanation();
      };
    }
    if (i === choiceIndex && !isCorrect) {
      btn.classList.add('incorrect');
      iconEl.textContent = 'Your Pick';
    }
  });

  document.getElementById('quiz-next-btn').style.display = 'block';

  // Track answer for results + domain breakdown
  currentQuiz.answers.push({
    questionId: q.id,
    correct: isCorrect,
    sourceDomain: q.sourceDomain
  });
}

// ============================================================
// MISSED POOL + RECOVERY TRACKING
// A question enters the missed pool when answered incorrectly.
// It is removed only after 2 correct answers while in the pool.
// A wrong answer while in recovery resets its count back to 0.
// Recovery counts are stored separately in ccma_missed_recovery.
// ============================================================
function updateMissedPool(questionId, isCorrect) {
  let missed = getStorage(STORAGE_KEYS.missedPool, []);
  let recovery = getStorage(STORAGE_KEYS.missedRecovery, {});
  const inMissed = missed.includes(questionId);

  if (!isCorrect) {
    // Wrong answer: add to missed pool if not already there, reset recovery count
    if (!inMissed) missed.push(questionId);
    recovery[questionId] = 0;
  } else if (inMissed) {
    // Correct answer while in missed pool: increment recovery count
    recovery[questionId] = (recovery[questionId] || 0) + 1;
    if (recovery[questionId] >= 2) {
      // Graduated — remove from pool and clean up recovery tracking
      missed = missed.filter(id => id !== questionId);
      delete recovery[questionId];
    }
  }
  // Correct answer on a question not in missed pool: no missed-pool change needed

  setStorage(STORAGE_KEYS.missedPool, missed);
  setStorage(STORAGE_KEYS.missedRecovery, recovery);
}

function updateAnsweredCorrectly(questionId, isCorrect) {
  let answeredCorrectly = getStorage(STORAGE_KEYS.answeredCorrectly, []);
  if (isCorrect && !answeredCorrectly.includes(questionId)) {
    answeredCorrectly.push(questionId);
    setStorage(STORAGE_KEYS.answeredCorrectly, answeredCorrectly);
  }
}

function toggleExplanation() {
  const box = document.getElementById('quiz-explanation-box');
  const toggle = document.getElementById('quiz-explanation-toggle');
  if (!box || !toggle) return;
  const isOpen = box.style.display === 'block';
  box.style.display = isOpen ? 'none' : 'block';
  toggle.classList.toggle('open', !isOpen);
  toggle.innerHTML = isOpen
    ? 'Show Explanation <span class="chevron">⌄</span>'
    : 'Hide Explanation <span class="chevron">⌃</span>';
}

function nextQuestion() {
  currentQuiz.currentIndex++;
  if (currentQuiz.currentIndex >= currentQuiz.questions.length) {
    finishQuiz();
  } else {
    renderQuizQuestion();
  }
}

function quitQuiz() {
  const confirmed = confirm('Quit this quiz? Your progress on this attempt will not be saved.');
  if (!confirmed) return;
  currentQuiz = null;
  setUnloadProtection(false);
  showScreen('home');
}

// ============================================================
// QUIZ COMPLETION + RESULTS
// ============================================================
function finishQuiz() {
  setUnloadProtection(false);
  const total = currentQuiz.answers.length;
  const correct = currentQuiz.answers.filter(a => a.correct).length;
  const percent = total > 0 ? Math.round((correct / total) * 100) : 0;

  // Mastery and the missed-questions pool only update on a completed quiz.
  // Quitting early discards all progress from that attempt, by design.
  currentQuiz.answers.forEach(a => {
    updateMissedPool(a.questionId, a.correct);
    updateAnsweredCorrectly(a.questionId, a.correct);
  });

  // Build domain breakdown
  const breakdown = {}; // domainKey -> { correct, total }
  currentQuiz.answers.forEach(a => {
    if (!breakdown[a.sourceDomain]) breakdown[a.sourceDomain] = { correct: 0, total: 0 };
    breakdown[a.sourceDomain].total++;
    if (a.correct) breakdown[a.sourceDomain].correct++;
  });

  // Save attempt record
  const attempts = getStorage(STORAGE_KEYS.attempts, []);
  const attemptRecord = {
    type: currentQuiz.type,
    domainKey: currentQuiz.domainKey,
    length: currentQuiz.length,
    correct, total, percent,
    date: new Date().toISOString(),
    breakdown
  };
  attempts.unshift(attemptRecord);
  setStorage(STORAGE_KEYS.attempts, attempts);

  // Update running domain stats. NOTE: this is currently write-only - nothing
  // reads ccma_domain_stats yet. The Progress screen's domain percentages are
  // computed live from QUESTIONS + answeredCorrectly instead (see
  // renderProgressScreen). Leaving this in since it's harmless and may be
  // wanted later (e.g. correct/total over time vs. just current mastery),
  // but flagging so it isn't mistaken for dead code by accident.
  const domainStats = getStorage(STORAGE_KEYS.domainStats, {});
  Object.keys(breakdown).forEach(domKey => {
    if (!domainStats[domKey]) domainStats[domKey] = { correct: 0, total: 0 };
    domainStats[domKey].correct += breakdown[domKey].correct;
    domainStats[domKey].total += breakdown[domKey].total;
  });
  setStorage(STORAGE_KEYS.domainStats, domainStats);

  renderResultsScreen(attemptRecord);
  updateMissedButtonState();
  showScreen('results');
}

function renderResultsScreen(record) {
  document.getElementById('results-percent').textContent = `${record.percent}%`;
  document.getElementById('results-fraction').textContent = `${record.correct} of ${record.total} correct`;
  document.getElementById('results-quiz-type').textContent = `${quizTypeLabel(record)} · ${record.length} questions`;

  const container = document.getElementById('results-domain-breakdown');
  container.innerHTML = '';
  // Show in exam-weight order, only domains that had questions this attempt
  const keysWithData = DOMAIN_DISPLAY_ORDER.filter(k => record.breakdown[k]);
  const termHasData = record.breakdown['terminology'];
  const orderedKeys = termHasData ? [...keysWithData, 'terminology'] : keysWithData;

  orderedKeys.forEach(key => {
    const stat = record.breakdown[key];
    const pct = Math.round((stat.correct / stat.total) * 100);
    const row = document.createElement('div');
    row.className = 'domain-row';
    row.innerHTML = `
      <span class="domain-name">${getDomainDisplayName(key)}</span>
      <span class="domain-score">${pct}%</span>
    `;
    container.appendChild(row);
  });
}

function quizTypeLabel(record) {
  if (record.type === 'practice') return 'Practice Quiz';
  if (record.type === 'terminology') return 'Terminology Quiz';
  if (record.type === 'missed') return 'Missed Questions';
  if (record.type === 'domain') return getDomainDisplayName(record.domainKey) + ' Study';
  return 'Quiz';
}

// ============================================================
// PROGRESS SCREEN RENDERING
// ============================================================
function renderProgressScreen() {
  const existingIds = getAllQuestionIds();
  // Only count IDs that still exist in the current question bank
  const rawAnsweredCorrectly = getStorage(STORAGE_KEYS.answeredCorrectly, []);
  const answeredCorrectly = new Set(rawAnsweredCorrectly.filter(id => existingIds.has(id)));
  const listEl = document.getElementById('domain-score-list');
  listEl.innerHTML = '';

  // Recent Attempts starts collapsed each time Progress is opened fresh
  const attemptsContainer = document.getElementById('recent-attempts-container');
  const attemptsToggle = document.getElementById('recent-attempts-toggle');
  attemptsContainer.hidden = true;
  attemptsToggle.setAttribute('aria-expanded', 'false');

  DOMAIN_DISPLAY_ORDER.forEach(key => {
    const totalInDomain = (QUESTIONS[key] || []).length;
    const masteredInDomain = (QUESTIONS[key] || []).filter(q => answeredCorrectly.has(q.id)).length;
    const row = document.createElement('div');
    row.className = 'domain-row';
    if (totalInDomain > 0) {
      const pct = Math.round((masteredInDomain / totalInDomain) * 100);
      row.innerHTML = `<span class="domain-name">${DOMAINS[key].name}</span><span class="domain-score">${pct}%</span>`;
    } else {
      row.innerHTML = `<span class="domain-name">${DOMAINS[key].name}</span><span class="domain-score empty">—</span>`;
    }
    listEl.appendChild(row);
  });

  // Terminology row appears last in the list, styled identically to other domain rows
  const termTotal = (QUESTIONS['terminology'] || []).length;
  const termMastered = (QUESTIONS['terminology'] || []).filter(q => answeredCorrectly.has(q.id)).length;
  const termRow = document.createElement('div');
  termRow.className = 'domain-row';
  if (termTotal > 0) {
    const pct = Math.round((termMastered / termTotal) * 100);
    termRow.innerHTML = `<span class="domain-name">Terminology</span><span class="domain-score">${pct}%</span>`;
  } else {
    termRow.innerHTML = `<span class="domain-name">Terminology</span><span class="domain-score empty">—</span>`;
  }
  listEl.appendChild(termRow);

  // Recent attempts (last 5)
  const attempts = getStorage(STORAGE_KEYS.attempts, []);
  const recentContainer = document.getElementById('recent-attempts-container');
  recentContainer.innerHTML = '';

  if (attempts.length === 0) {
    recentContainer.innerHTML = '<div class="empty-state">No quiz attempts yet. Start a quiz from Home to see your progress here.</div>';
    return;
  }

  const listDiv = document.createElement('div');
  listDiv.className = 'attempt-list';
  attempts.slice(0, 5).forEach(a => {
    const row = document.createElement('div');
    row.className = 'attempt-row';
    const dateStr = new Date(a.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    row.innerHTML = `
      <div class="attempt-top">
        <span class="attempt-type">${quizTypeLabel(a)}</span>
        <span class="attempt-score">${a.percent}%</span>
      </div>
      <div class="attempt-bottom">
        <span>${a.length} questions</span>
        <span>${dateStr}</span>
      </div>
    `;
    listDiv.appendChild(row);
  });
  recentContainer.appendChild(listDiv);
}

// ============================================================
// RECENT ATTEMPTS TOGGLE
// ============================================================
function toggleRecentAttempts() {
  const container = document.getElementById('recent-attempts-container');
  const toggle = document.getElementById('recent-attempts-toggle');
  const isOpen = !container.hidden;
  container.hidden = isOpen;
  toggle.setAttribute('aria-expanded', String(!isOpen));
}

// ============================================================
// CLEAR HISTORY
// ============================================================
function clearHistory() {
  const confirmed = confirm('This will permanently erase all attempt history, domain scores, and missed questions. This cannot be undone. Continue?');
  if (!confirmed) return;

  localStorage.removeItem(STORAGE_KEYS.attempts);
  localStorage.removeItem(STORAGE_KEYS.domainStats);
  localStorage.removeItem(STORAGE_KEYS.missedPool);
  localStorage.removeItem(STORAGE_KEYS.missedRecovery);
  localStorage.removeItem(STORAGE_KEYS.answeredCorrectly);

  updateMissedButtonState();
  renderProgressScreen();
}
