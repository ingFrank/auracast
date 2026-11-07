(() => {
  'use strict';

  // ============================================================
  // CONSTANTS & STORAGE KEYS
  // ============================================================
  const STORAGE_PROGRESS_KEY = 'auracast_progress_v1';
  const STORAGE_LAST_PLAYED_KEY = 'auracast_last_played_v1';
  const STORAGE_SETTINGS_KEY = 'auracast_settings_v1';
  const STORAGE_CACHED_CATALOG_KEY = 'auracast_cached_catalog_empty_v2';
  const STORAGE_OFFLINE_META_KEY = 'auracast_offline_meta_v2';
  const STORAGE_CUSTOM_FOLDERS_KEY = 'auracast_custom_folders_v2';
  const STORAGE_APPEARANCE_KEY = 'auracast_appearance_v1';

  const IDB_NAME = 'auracast_offline_db';
  const IDB_VERSION = 2;
  const IDB_STORE_EPISODES = 'episodes'; // legacy v1 store
  const IDB_STORE_META = 'episodes_meta';
  const IDB_STORE_CHUNKS = 'episodes_chunks';
  const OFFLINE_CHUNK_SIZE = 4 * 1024 * 1024; // 4 MB chunks for zero mobile RAM/IPC limit issues

  const naturalCollator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

  // ============================================================
  // APPLICATION STATE
  // ============================================================
  const state = {
    appearance: {
      theme: 'dark', // 'dark' | 'light'
      style: 'podcasts', // 'podcasts' | 'music'
      animatedArt: true,
      vizReactive: true, // visualizer follows the real voice (Web Audio analyser)
      vizAmbient: true, // liquid colour backdrop behind the visualizer
      libraryLayout: 'grid', // 'grid' | 'carousel' | 'list'
      coverStyle: 'icon', // 'number' | 'icon' | 'geo'
      hideCompleted: false // hide 100% topics everywhere except the "Terminados" filter
    },
    topics: [], // Array of { id, name, coverUrl, episodes: [...] }
    selectedTopicId: null,
    currentEpisode: null,
    currentTopic: null,
    isPlaying: false,
    isScrubbing: false,
    playbackRate: 1,
    activeFilter: 'all',
    searchQuery: '',
    progressMap: {}, // episodeId -> { currentTime, duration, completed, updatedAt, bookmarks: [] }
    lastPlayed: null, // { episodeId, topicId, updatedAt }
    offlineEpisodeIds: new Set(),
    offlineIdAliasMap: new Map(), // currentEpisodeId -> storedIndexedDbKey
    downloadingEpisodes: new Map(), // episodeId -> { status: 'queued'|'downloading', pct: 0, loadedBytes: 0, totalBytes: 0 }
    downloadQueue: [],
    isProcessingQueue: false,
    wakeLockSentinel: null,
    playbackWakeLock: null,
    activeBlob: null, // Strong JS heap reference prevents Android Chrome garbage-collecting the offline Blob during screen-off!
    activeBlobUrl: null,
    userRequestedPause: false,
    recoveryAttempts: 0,
    sleepTimer: {
      mode: null, // null | 'countdown' | 'end-of-episode'
      endsAt: null,
      intervalId: null
    },
    uploadTargetTopic: null,
    artworkCache: new Map()
  };

  // ============================================================
  // DOM ELEMENTS
  // ============================================================
  const audio = document.getElementById('audioElement');
  const connectionBadge = document.getElementById('connectionBadge');
  const homeView = document.getElementById('homeView');
  const topicDetailView = document.getElementById('topicDetailView');
  const continueListeningContainer = document.getElementById('continueListeningContainer');
  const libraryStats = document.getElementById('libraryStats');
  const topicsGrid = document.getElementById('topicsGrid');
  const topicsCountBadge = document.getElementById('topicsCountBadge');
  const searchInput = document.getElementById('searchInput');
  const clearSearchBtn = document.getElementById('clearSearchBtn');

  // Topic Detail Elements
  const backToTopicsBtn = document.getElementById('backToTopicsBtn');
  const topicHeroContainer = document.getElementById('topicHeroContainer');
  const episodesListCount = document.getElementById('episodesListCount');
  const episodesListContainer = document.getElementById('episodesListContainer');
  const markAllTopicCompletedBtn = document.getElementById('markAllTopicCompletedBtn');

  // Mini Player Elements
  const miniPlayer = document.getElementById('miniPlayer');
  const miniProgressFill = document.getElementById('miniProgressFill');
  const miniExpandTapArea = document.getElementById('miniExpandTapArea');
  const miniCover = document.getElementById('miniCover');
  const miniTitle = document.getElementById('miniTitle');
  const miniTopic = document.getElementById('miniTopic');
  const miniTime = document.getElementById('miniTime');
  const miniRewindBtn = document.getElementById('miniRewindBtn');
  const miniPlayPauseBtn = document.getElementById('miniPlayPauseBtn');
  const miniPlayIcon = document.getElementById('miniPlayIcon');
  const miniPauseIcon = document.getElementById('miniPauseIcon');
  const miniForwardBtn = document.getElementById('miniForwardBtn');

  // Full Player Elements
  const fullPlayerOverlay = document.getElementById('fullPlayerOverlay');
  const closeFullPlayerBtn = document.getElementById('closeFullPlayerBtn');
  const fpHeaderTopic = document.getElementById('fpHeaderTopic');
  const fpGoToTopicBtn = document.getElementById('fpGoToTopicBtn');
  const fpArtworkContainer = document.getElementById('fpArtworkContainer');
  const fpArtwork = document.getElementById('fpArtwork');
  const fpPlayingWaves = document.getElementById('fpPlayingWaves');
  const fpTitle = document.getElementById('fpTitle');
  const fpSubtitle = document.getElementById('fpSubtitle');
  const fpSaveBookmarkBtn = document.getElementById('fpSaveBookmarkBtn');
  const fpSleepActivePill = document.getElementById('fpSleepActivePill');
  const fpSeekSlider = document.getElementById('fpSeekSlider');
  const fpRangeProgress = document.getElementById('fpRangeProgress');
  const fpCurrentTime = document.getElementById('fpCurrentTime');
  const fpPercentLabel = document.getElementById('fpPercentLabel');
  const fpRemainingTime = document.getElementById('fpRemainingTime');
  const fpPrevEpBtn = document.getElementById('fpPrevEpBtn');
  const fpRewind15Btn = document.getElementById('fpRewind15Btn');
  const fpPlayPauseBtn = document.getElementById('fpPlayPauseBtn');
  const fpPlayIcon = document.getElementById('fpPlayIcon');
  const fpPauseIcon = document.getElementById('fpPauseIcon');
  const fpForward15Btn = document.getElementById('fpForward15Btn');
  const fpNextEpBtn = document.getElementById('fpNextEpBtn');
  const fpSpeedBtn = document.getElementById('fpSpeedBtn');
  const fpSpeedLabel = document.getElementById('fpSpeedLabel');
  const fpSleepBtn = document.getElementById('fpSleepBtn');
  const fpSleepCaption = document.getElementById('fpSleepCaption');
  const fpToggleCompleteBtn = document.getElementById('fpToggleCompleteBtn');
  const fpCompleteCaption = document.getElementById('fpCompleteCaption');
  const fpSaveOfflineBtn = document.getElementById('fpSaveOfflineBtn');
  const fpOfflineCaption = document.getElementById('fpOfflineCaption');
  const fpBookmarksContainer = document.getElementById('fpBookmarksContainer');

  // File Inputs & Modals
  const folderPickerInput = document.getElementById('folderPickerInput');
  const filesPickerInput = document.getElementById('filesPickerInput');
  const persistImportedCheckbox = document.getElementById('persistImportedCheckbox');
  const offlineStorageCount = document.getElementById('offlineStorageCount');
  const clearOfflineStorageBtn = document.getElementById('clearOfflineStorageBtn');

  // ============================================================
  // UTILITIES & FORMATTING
  // ============================================================
  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const totalSec = Math.floor(seconds);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');
    if (hrs > 0) {
      return `${hrs}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }

  function cleanTitleFromFilename(fileName) {
    return fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/_/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function showToast(message) {
    const container = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast-msg';
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s ease';
      setTimeout(() => el.remove(), 260);
    }, 2700);
  }

  function hashString(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }

  const PALETTES = [
    ['#E89D3C', '#9E4716', '#181424'],
    ['#38BDF8', '#1D4ED8', '#0F172A'],
    ['#34D399', '#047857', '#0D1F1C'],
    ['#F472B6', '#9D174D', '#231220'],
    ['#A78BFA', '#5B21B6', '#19132B'],
    ['#FBBF24', '#B45309', '#241A10'],
    ['#FB7185', '#BE123C', '#251118'],
    ['#2DD4BF', '#0F766E', '#0B1F1E'],
    ['#818CF8', '#3730A3', '#14142B'],
    ['#F97316', '#9A3412', '#22140C'],
    ['#4ADE80', '#15803D', '#0E1F14'],
    ['#E879F9', '#86198F', '#22102A']
  ];

  function getTopicNumber(topicName) {
    const m = String(topicName || '').match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Numbered folders get one distinct palette each; the rest fall back to a name hash
  function getTopicPalette(topicName) {
    const num = getTopicNumber(topicName);
    const idx = num !== null ? num % PALETTES.length : hashString(topicName || 'Podcast') % PALETTES.length;
    return PALETTES[idx];
  }

  // Outline icons (24x24 grid) matched to the topic by keywords in the folder name
  const TOPIC_ICONS = [
    [/misional/, '<path d="M3 21h18M3 10h18M5 6.5l7-3.5 7 3.5M5 10v11M19 10v11M9 14v4M12 14v4M15 14v4"/>'],
    [/estructura|organiza/, '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2"/>'],
    [/declaracion/, '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z"/><path d="M9 9h1M9 13h6M9 17h6"/>'],
    [/recaudo|recaudar/, '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 12h.01M18 12h.01"/>'],
    [/sancion/, '<path d="M13 10l7.5 7.5a1.5 1.5 0 0 1-2.1 2.1L11 12"/><path d="M5.5 8.5l5-5 5 5-5 5z"/><path d="M3 21h8"/>'],
    [/contab|financ/, '<rect x="5" y="3" width="14" height="18" rx="2"/><rect x="8" y="6" width="8" height="3" rx="1"/><path d="M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01M16 17h.01"/>'],
    [/extincion/, '<path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2z"/><path d="M9 11l2 2 4-4"/>'],
    [/devolucion|compensacion/, '<path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-3-2-2 2-2-2-2 2-2-2z"/><path d="M15 14v-1.5a2 2 0 0 0-2-2H9M11 8.5l-2 2 2 2"/>'],
    [/titulo|ejecutiv/, '<circle cx="12" cy="9" r="5.5"/><path d="M9 14l-1 7 4-2 4 2-1-7"/><path d="M10 9l1.5 1.5L14.5 7.5"/>'],
    [/cobro|coactiv|persuasiv/, '<path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0z"/>'],
    [/razonamiento|logic|analitic/, '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z"/>'],
    [/guia|estudio|repaso/, '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7h6M9 10.5h4"/>']
  ];
  const DEFAULT_TOPIC_ICON = '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>';

  function getTopicIconPaths(topicName) {
    const norm = String(topicName || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const hit = TOPIC_ICONS.find(([re]) => re.test(norm));
    return hit ? hit[1] : DEFAULT_TOPIC_ICON;
  }

  function getTopicInitials(topicName) {
    const cleaned = (topicName || 'P')
      .replace(/^\d+[\s._-]*/, '')
      .trim();
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return cleaned.slice(0, 2).toUpperCase() || 'PC';
  }

  function renderTopicArtworkSVG(topicName, coverUrl) {
    if (coverUrl) {
      return `<img src="${coverUrl}" alt="${topicName}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" />`;
    }
    const [c1, c2, c3] = getTopicPalette(topicName);
    const coverStyle = state.appearance.coverStyle || 'icon';
    const num = getTopicNumber(topicName);
    const numLabel = num !== null ? String(num).padStart(2, '0') : getTopicInitials(topicName);
    const gradId = `g_${coverStyle}_${hashString(topicName)}`;
    const font = 'font-family="Inter, -apple-system, sans-serif"';

    let art = '';
    if (coverStyle === 'number') {
      art = `
        <circle cx="38" cy="44" r="78" fill="rgba(255,255,255,0.08)" />
        <text x="22" y="36" fill="rgba(255,255,255,0.85)" ${font} font-size="13" font-weight="700" letter-spacing="0.14em">TEMA</text>
        <text x="194" y="190" text-anchor="end" fill="#ffffff" fill-opacity="0.94" ${font} font-size="${numLabel.length > 2 ? 92 : 124}" font-weight="800" letter-spacing="-0.06em">${numLabel}</text>`;
    } else if (coverStyle === 'geo') {
      // Deterministic abstract pattern: same topic always gets the same artwork
      let seed = hashString(topicName || 'Podcast') || 1;
      const rnd = () => {
        seed = (Math.imul(seed ^ (seed >>> 15), 2246822507) + 0x6d2b79f5) >>> 0;
        return (seed % 10000) / 10000;
      };
      let shapes = '';
      for (let k = 0; k < 5; k++) {
        shapes += `<circle cx="${Math.round(rnd() * 200)}" cy="${Math.round(rnd() * 200)}" r="${Math.round(40 + rnd() * 80)}" fill="none" stroke="#fff" stroke-opacity="${(0.12 + k * 0.06).toFixed(2)}" stroke-width="${(1 + k * 1.4).toFixed(1)}" />`;
      }
      const lx = Math.round(rnd() * 120);
      shapes += `<path d="M${lx} 200 L${lx + 80} 0" stroke="#fff" stroke-opacity="0.16" stroke-width="10" />`;
      shapes += `<circle cx="${Math.round(30 + rnd() * 140)}" cy="${Math.round(30 + rnd() * 110)}" r="${Math.round(12 + rnd() * 10)}" fill="#fff" fill-opacity="0.88" />`;
      art = `${shapes}
        <text x="18" y="184" fill="#ffffff" ${font} font-size="26" font-weight="800" letter-spacing="-0.03em">${numLabel}</text>`;
    } else {
      art = `
        <circle cx="100" cy="90" r="64" fill="rgba(255,255,255,0.1)" stroke="rgba(255,255,255,0.18)" stroke-width="1.4" />
        <g transform="translate(58 48) scale(3.5)" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${getTopicIconPaths(topicName)}</g>
        <text x="18" y="184" fill="rgba(255,255,255,0.9)" ${font} font-size="13" font-weight="700" letter-spacing="0.14em">${num !== null ? `TEMA ${numLabel}` : numLabel}</text>`;
    }

    return `
      <svg viewBox="0 0 200 200" width="100%" height="100%" xmlns="http://www.w3.org/2000/svg" style="border-radius:inherit;display:block;">
        <defs>
          <linearGradient id="${gradId}" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${c1}" />
            <stop offset="58%" stop-color="${c2}" />
            <stop offset="100%" stop-color="${c3}" />
          </linearGradient>
          <radialGradient id="r_${gradId}" cx="30%" cy="20%" r="75%">
            <stop offset="0%" stop-color="rgba(255,255,255,0.22)" />
            <stop offset="100%" stop-color="rgba(0,0,0,0.28)" />
          </radialGradient>
        </defs>
        <rect width="200" height="200" fill="url(#${gradId})" />
        <rect width="200" height="200" fill="url(#r_${gradId})" />
        ${art}
      </svg>
    `;
  }

  // Generate 512x512 DataURL PNG for Lock Screen / Media Session
  function getLockScreenArtworkDataUrl(topicName, episodeTitle) {
    const cacheKey = `${topicName}::${episodeTitle}`;
    if (state.artworkCache.has(cacheKey)) {
      return state.artworkCache.get(cacheKey);
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      const [c1, c2, c3] = getTopicPalette(topicName);

      const grad = ctx.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.55, c2);
      grad.addColorStop(1, c3);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 512, 512);

      // Decorative rings
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(256, 210, 130, 0, Math.PI * 2);
      ctx.stroke();

      ctx.fillStyle = 'rgba(9, 10, 15, 0.35)';
      ctx.beginPath();
      ctx.arc(256, 210, 96, 0, Math.PI * 2);
      ctx.fill();

      // Initials
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.font = '800 72px sans-serif';
      ctx.fillText(getTopicInitials(topicName), 256, 235);

      // Topic Name
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.font = '800 28px sans-serif';
      ctx.fillText((topicName || 'Podcast').slice(0, 26), 256, 395);

      // Episode Title
      ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
      ctx.font = '600 22px sans-serif';
      ctx.fillText((episodeTitle || '').slice(0, 32), 256, 435);

      const url = canvas.toDataURL('image/png');
      state.artworkCache.set(cacheKey, url);
      return url;
    } catch (e) {
      return 'icon.svg';
    }
  }

  // ============================================================
  // LOCAL STORAGE (PROGRESS, RESUME & SETTINGS)
  // ============================================================
  function loadLocalStorageState() {
    try {
      const rawProgress = localStorage.getItem(STORAGE_PROGRESS_KEY);
      if (rawProgress) {
        state.progressMap = JSON.parse(rawProgress) || {};
      }
    } catch (e) {
      state.progressMap = {};
    }

    try {
      const rawLast = localStorage.getItem(STORAGE_LAST_PLAYED_KEY);
      if (rawLast) {
        state.lastPlayed = JSON.parse(rawLast) || null;
      }
    } catch (e) {
      state.lastPlayed = null;
    }

    try {
      const rawSettings = localStorage.getItem(STORAGE_SETTINGS_KEY);
      if (rawSettings) {
        const parsed = JSON.parse(rawSettings);
        if (parsed && parsed.playbackRate) {
          state.playbackRate = Number(parsed.playbackRate) || 1;
        }
      }
    } catch (e) {}

    try {
      const rawAppearance = localStorage.getItem(STORAGE_APPEARANCE_KEY);
      if (rawAppearance) {
        const parsed = JSON.parse(rawAppearance) || {};
        state.appearance = {
          ...state.appearance,
          ...parsed,
          // Migrate old v10 default where animatedArt was unintentionally saved as false
          animatedArt: parsed.userToggledAnimatedArt !== undefined ? Boolean(parsed.animatedArt) : true
        };
      }
    } catch (e) {}
  }

  function applyAppearance(patch) {
    if (patch) {
      if ('animatedArt' in patch) {
        patch.userToggledAnimatedArt = true;
      }
      state.appearance = { ...state.appearance, ...patch };
    }
    try {
      localStorage.setItem(STORAGE_APPEARANCE_KEY, JSON.stringify(state.appearance));
    } catch (e) {}

    const theme = state.appearance.theme === 'light' ? 'light' : 'dark';
    const style = state.appearance.style === 'music' ? 'music' : 'podcasts';

    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-style', style);
    root.style.colorScheme = theme;
    if (document.body) {
      document.body.setAttribute('data-theme', theme);
      document.body.setAttribute('data-style', style);
    }

    const metaTheme = document.getElementById('metaThemeColor');
    if (metaTheme) {
      metaTheme.setAttribute('content', theme === 'light' ? '#f2f2f7' : '#000000');
    }
    const metaCS = document.getElementById('metaColorScheme');
    if (metaCS) {
      metaCS.setAttribute('content', theme);
    }

    const themeSeg = document.getElementById('themeSegmented');
    if (themeSeg) {
      const idx = theme === 'light' ? 0 : 1;
      themeSeg.style.setProperty('--seg-index', idx);
      themeSeg.querySelectorAll('[data-theme-opt]').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-theme-opt') === theme);
      });
    }

    document.querySelectorAll('.style-card').forEach(card => {
      card.classList.toggle('active', card.getAttribute('data-style-opt') === style);
    });

    const animatedToggle = document.getElementById('animatedArtToggle');
    if (animatedToggle) {
      animatedToggle.checked = Boolean(state.appearance.animatedArt);
    }

    const vizRow = document.getElementById('vizStyleSelectorRow');
    if (vizRow) {
      vizRow.classList.toggle('hidden', !state.appearance.animatedArt);
    }
    document.querySelectorAll('.viz-extra-row').forEach(row => {
      row.classList.toggle('hidden', !state.appearance.animatedArt);
    });
    const hideCompletedToggle = document.getElementById('hideCompletedToggle');
    if (hideCompletedToggle) hideCompletedToggle.checked = Boolean(state.appearance.hideCompleted);
    const reactiveToggle = document.getElementById('vizReactiveToggle');
    if (reactiveToggle) reactiveToggle.checked = state.appearance.vizReactive !== false;
    const ambientToggle = document.getElementById('vizAmbientToggle');
    if (ambientToggle) ambientToggle.checked = state.appearance.vizAmbient !== false;
    document.querySelectorAll('[data-layout-opt]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-layout-opt') === (state.appearance.libraryLayout || 'grid'));
    });
    document.querySelectorAll('[data-cover-opt]').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-cover-opt') === (state.appearance.coverStyle || 'icon'));
    });

    const canvas = document.getElementById('fpVisualizerCanvas');
    const fpArt = document.getElementById('fpArtwork');
    const pill = document.getElementById('fpModeSwitcherPill');
    if (canvas && fpArt) {
      if (state.appearance.animatedArt) {
        canvas.classList.remove('hidden');
        fpArt.classList.add('hidden');
        if (pill) pill.classList.remove('hidden');
        if (!fullPlayerOverlay.classList.contains('hidden')) startVisualizerLoop();
      } else {
        canvas.classList.add('hidden');
        fpArt.classList.remove('hidden');
        if (pill) pill.classList.add('hidden');
        stopVisualizerLoop();
      }
    }
  }

  function toggleTheme() {
    const nextTheme = state.appearance.theme === 'light' ? 'dark' : 'light';
    applyAppearance({ theme: nextTheme });
    showToast(`Modo ${nextTheme === 'light' ? 'claro' : 'oscuro'} activado`);
  }

  async function updatePlaybackWakeLock(shouldLock) {
    if (shouldLock) {
      try {
        if ('wakeLock' in navigator && !state.playbackWakeLock) {
          state.playbackWakeLock = await navigator.wakeLock.request('screen');
          state.playbackWakeLock.addEventListener('release', () => {
            state.playbackWakeLock = null;
          });
        }
      } catch (e) {}
    } else if (state.playbackWakeLock) {
      try {
        await state.playbackWakeLock.release();
      } catch (e) {}
      state.playbackWakeLock = null;
    }
  }

  function updateBackdropMesh(topicName) {
    const [c1, c2, c3] = getTopicPalette(topicName);
    const b1 = document.querySelector('.fp-blob-1');
    const b2 = document.querySelector('.fp-blob-2');
    const b3 = document.querySelector('.fp-blob-3');
    if (b1) b1.style.background = `radial-gradient(circle, ${c1} 0%, transparent 70%)`;
    if (b2) b2.style.background = `radial-gradient(circle, ${c2} 0%, transparent 70%)`;
    if (b3) b3.style.background = `radial-gradient(circle, ${c3} 0%, transparent 70%)`;
  }

  function saveProgressToStorage() {
    try {
      localStorage.setItem(STORAGE_PROGRESS_KEY, JSON.stringify(state.progressMap));
    } catch (e) {}
  }

  function saveLastPlayedToStorage(episodeId, topicId) {
    state.lastPlayed = {
      episodeId,
      topicId,
      updatedAt: Date.now()
    };
    try {
      localStorage.setItem(STORAGE_LAST_PLAYED_KEY, JSON.stringify(state.lastPlayed));
    } catch (e) {}
  }

  function saveSettingsToStorage() {
    try {
      localStorage.setItem(STORAGE_SETTINGS_KEY, JSON.stringify({
        playbackRate: state.playbackRate
      }));
    } catch (e) {}
  }

  // ============================================================
  // CUSTOM FOLDERS MANAGEMENT (OFFLINE & MOBILE-FIRST)
  // ============================================================
  function loadCustomFolders() {
    try {
      const raw = localStorage.getItem(STORAGE_CUSTOM_FOLDERS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter(Boolean);
      }
    } catch (e) {}
    return [];
  }

  function saveCustomFolder(folderName) {
    if (!folderName || typeof folderName !== 'string') return;
    const trimmed = folderName.trim();
    if (!trimmed) return;
    const folders = loadCustomFolders();
    if (!folders.includes(trimmed)) {
      folders.push(trimmed);
      try {
        localStorage.setItem(STORAGE_CUSTOM_FOLDERS_KEY, JSON.stringify(folders));
      } catch (e) {}
    }
  }

  function deleteCustomFolder(folderName) {
    if (!folderName) return;
    const folders = loadCustomFolders().filter(f => f !== folderName);
    try {
      localStorage.setItem(STORAGE_CUSTOM_FOLDERS_KEY, JSON.stringify(folders));
    } catch (e) {}
  }

  function promptCreateNewFolder(defaultName = '') {
    const name = window.prompt(
      'Nombre de la nueva carpeta / tema:\n(Ejemplo: 13. Integridad - Comportamental, 14 DATOS, etc.):',
      defaultName
    );
    if (!name || !name.trim()) return null;
    const folderName = name.trim();
    saveCustomFolder(folderName);

    let topic = state.topics.find(t => t.name.toLowerCase() === folderName.toLowerCase());
    if (!topic) {
      topic = {
        id: `topic::${folderName}`,
        name: folderName,
        isCustom: true,
        coverUrl: null,
        episodeCount: 0,
        episodes: []
      };
      state.topics.push(topic);
      state.topics.sort((a, b) => naturalCollator.compare(a.name, b.name));
    }
    renderAll();
    openTopicView(topic.id);
    showToast(`Carpeta "${folderName}" lista. Toca "+ Cargar audios" para agregar audios.`);
    return folderName;
  }

  function getEpisodeProgress(episodeId) {
    return state.progressMap[episodeId] || {
      currentTime: 0,
      duration: 0,
      completed: false,
      updatedAt: 0,
      bookmarks: []
    };
  }

  function updateEpisodeProgress(episodeId, partial) {
    const existing = getEpisodeProgress(episodeId);
    state.progressMap[episodeId] = {
      ...existing,
      ...partial,
      updatedAt: Date.now()
    };
    saveProgressToStorage();
  }

  // ============================================================
  // INDEXEDDB FOR OFFLINE PHONE STORAGE (CHUNKED + INSTANT META)
  // ============================================================
  let cachedDbPromise = null;
  function openDatabase() {
    if (cachedDbPromise) return cachedDbPromise;
    cachedDbPromise = new Promise(resolve => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        cachedDbPromise = null;
        resolve(null);
      }, 5000);
      try {
        const req = indexedDB.open(IDB_NAME, IDB_VERSION);
        req.onupgradeneeded = event => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE_EPISODES)) {
            db.createObjectStore(IDB_STORE_EPISODES, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(IDB_STORE_META)) {
            db.createObjectStore(IDB_STORE_META, { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains(IDB_STORE_CHUNKS)) {
            const chunkStore = db.createObjectStore(IDB_STORE_CHUNKS, { keyPath: 'key' });
            chunkStore.createIndex('by_episode', 'episodeId', { unique: false });
          }
        };
        req.onsuccess = () => {
          clearTimeout(timer);
          const db = req.result;
          db.onversionchange = () => {
            db.close();
            cachedDbPromise = null;
          };
          resolve(db);
        };
        req.onerror = () => {
          clearTimeout(timer);
          cachedDbPromise = null;
          resolve(null);
        };
        req.onblocked = () => {
          clearTimeout(timer);
          cachedDbPromise = null;
          resolve(null);
        };
      } catch (e) {
        clearTimeout(timer);
        cachedDbPromise = null;
        resolve(null);
      }
    });
    return cachedDbPromise;
  }

  function loadCachedOfflineMetaMap() {
    try {
      const raw = localStorage.getItem(STORAGE_OFFLINE_META_KEY);
      if (raw) {
        return JSON.parse(raw) || {};
      }
    } catch (e) {}
    return {};
  }

  function saveCachedOfflineMetaEntry(metaRecord) {
    try {
      const map = loadCachedOfflineMetaMap();
      map[metaRecord.id] = {
        id: metaRecord.id,
        topicName: metaRecord.topicName,
        fileName: metaRecord.fileName,
        title: metaRecord.title,
        episodeNumber: metaRecord.episodeNumber || 1,
        size: metaRecord.size || 0,
        mimeType: metaRecord.mimeType || 'audio/mp4',
        chunkCount: metaRecord.chunkCount || 0,
        savedAt: metaRecord.savedAt || Date.now()
      };
      localStorage.setItem(STORAGE_OFFLINE_META_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  function removeCachedOfflineMetaEntry(episodeId) {
    try {
      const map = loadCachedOfflineMetaMap();
      delete map[episodeId];
      localStorage.setItem(STORAGE_OFFLINE_META_KEY, JSON.stringify(map));
    } catch (e) {}
  }

  async function requestPersistentStorageAndWakeLock(enableWakeLock) {
    try {
      if (navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }
    } catch (e) {}

    if (enableWakeLock) {
      try {
        if ('wakeLock' in navigator && !state.wakeLockSentinel) {
          state.wakeLockSentinel = await navigator.wakeLock.request('screen');
          state.wakeLockSentinel.addEventListener('release', () => {
            state.wakeLockSentinel = null;
          });
        }
      } catch (e) {}
    } else if (state.wakeLockSentinel) {
      try {
        await state.wakeLockSentinel.release();
      } catch (e) {}
      state.wakeLockSentinel = null;
    }
  }

  async function putChunkToIDB(db, episodeId, chunkIndex, uint8Data) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_STORE_CHUNKS, 'readwrite');
        const store = tx.objectStore(IDB_STORE_CHUNKS);
        store.put({
          key: `${episodeId}::${chunkIndex}`,
          episodeId: episodeId,
          index: chunkIndex,
          data: uint8Data
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function putMetaToIDB(db, metaRecord) {
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_STORE_META, 'readwrite');
        tx.objectStore(IDB_STORE_META).put(metaRecord);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function saveEpisodeToIndexedDB(episodeRecord) {
    const db = await openDatabase();
    if (!db) return false;

    const blob = episodeRecord.blob;
    if (!blob) return false;

    const totalSize = blob.size || episodeRecord.size || 0;
    const mimeType = blob.type || 'audio/mp4';

    // Slice into 4MB chunks so mobile browsers never hit single-record IPC/RAM limits
    if (db.objectStoreNames.contains(IDB_STORE_CHUNKS) && db.objectStoreNames.contains(IDB_STORE_META)) {
      try {
        let offset = 0;
        let chunkIndex = 0;
        while (offset < totalSize) {
          const end = Math.min(offset + OFFLINE_CHUNK_SIZE, totalSize);
          const sliceBlob = blob.slice(offset, end);
          const arrayBuf = await sliceBlob.arrayBuffer();
          const ok = await putChunkToIDB(db, episodeRecord.id, chunkIndex, new Uint8Array(arrayBuf));
          if (!ok) {
            await deleteOfflineEpisodeById(episodeRecord.id);
            return false;
          }
          offset = end;
          chunkIndex++;
        }

        const metaRecord = {
          id: episodeRecord.id,
          topicName: episodeRecord.topicName,
          fileName: episodeRecord.fileName,
          title: episodeRecord.title,
          episodeNumber: episodeRecord.episodeNumber || 1,
          size: totalSize,
          mimeType: mimeType,
          chunkCount: chunkIndex,
          storageFormat: 'chunked-v2',
          savedAt: Date.now()
        };

        const metaOk = await putMetaToIDB(db, metaRecord);
        if (!metaOk) return false;

        saveCachedOfflineMetaEntry(metaRecord);
        state.offlineEpisodeIds.add(episodeRecord.id);
        state.offlineIdAliasMap.set(episodeRecord.id, episodeRecord.id);
        updateOfflineCountUI();
        return true;
      } catch (e) {
        return false;
      }
    }

    // Legacy v1 fallback
    return new Promise(resolve => {
      try {
        const tx = db.transaction(IDB_STORE_EPISODES, 'readwrite');
        const store = tx.objectStore(IDB_STORE_EPISODES);
        store.put(episodeRecord);
        tx.oncomplete = () => {
          saveCachedOfflineMetaEntry(episodeRecord);
          state.offlineEpisodeIds.add(episodeRecord.id);
          state.offlineIdAliasMap.set(episodeRecord.id, episodeRecord.id);
          updateOfflineCountUI();
          resolve(true);
        };
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  function parseEpisodeIdToMeta(idStr) {
    if (typeof idStr === 'string' && idStr.startsWith('srv::')) {
      const parts = idStr.split('::');
      if (parts.length >= 3) {
        const topicName = parts[1];
        const fileName = parts.slice(2).join('::');
        return {
          id: idStr,
          topicName,
          fileName,
          title: cleanTitleFromFilename(fileName),
          episodeNumber: 1,
          size: 0
        };
      }
    }
    return null;
  }

  async function getAllOfflineEpisodes() {
    const mergedMap = new Map();

    // 1. Load instant cached metadata from localStorage first
    const localMeta = loadCachedOfflineMetaMap();
    for (const [id, rec] of Object.entries(localMeta)) {
      if (rec && rec.id) {
        mergedMap.set(id, rec);
      }
    }

    const db = await openDatabase();
    if (!db) {
      return Array.from(mergedMap.values());
    }

    // 2. Read lightweight `episodes_meta` store (no 50MB blobs -> completes in <2ms!)
    if (db.objectStoreNames.contains(IDB_STORE_META)) {
      await new Promise(resolve => {
        try {
          const tx = db.transaction(IDB_STORE_META, 'readonly');
          const store = tx.objectStore(IDB_STORE_META);
          const req = store.getAll();
          req.onsuccess = () => {
            const list = req.result || [];
            for (const item of list) {
              if (item && item.id) {
                mergedMap.set(item.id, item);
                saveCachedOfflineMetaEntry(item);
              }
            }
            resolve();
          };
          req.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    }

    // 3. Read ONLY primary keys (`getAllKeys()`) from legacy `episodes` store (<2ms, never loads 50MB blobs!)
    if (db.objectStoreNames.contains(IDB_STORE_EPISODES)) {
      await new Promise(resolve => {
        try {
          const tx = db.transaction(IDB_STORE_EPISODES, 'readonly');
          const store = tx.objectStore(IDB_STORE_EPISODES);
          const req = store.getAllKeys();
          req.onsuccess = () => {
            const keys = req.result || [];
            for (const k of keys) {
              if (!mergedMap.has(k)) {
                const parsed = parseEpisodeIdToMeta(k);
                if (parsed) {
                  mergedMap.set(k, parsed);
                  saveCachedOfflineMetaEntry(parsed);
                } else {
                  mergedMap.set(k, {
                    id: String(k),
                    topicName: 'Importados',
                    fileName: String(k),
                    title: cleanTitleFromFilename(String(k)),
                    episodeNumber: 1,
                    size: 0
                  });
                }
              }
            }
            resolve();
          };
          req.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch (e) {
          resolve();
        }
      });
    }

    return Array.from(mergedMap.values());
  }

  async function getOfflineEpisodePlayableBlob(episodeId) {
    const db = await openDatabase();
    if (!db) return null;

    // 1. Check v2 chunked storage first
    if (db.objectStoreNames.contains(IDB_STORE_META) && db.objectStoreNames.contains(IDB_STORE_CHUNKS)) {
      const meta = await new Promise(resolve => {
        try {
          const tx = db.transaction(IDB_STORE_META, 'readonly');
          const req = tx.objectStore(IDB_STORE_META).get(episodeId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });

      if (meta && meta.chunkCount > 0) {
        const chunks = await new Promise(resolve => {
          try {
            const tx = db.transaction(IDB_STORE_CHUNKS, 'readonly');
            const store = tx.objectStore(IDB_STORE_CHUNKS);
            const idx = store.index('by_episode');
            const req = idx.getAll(episodeId);
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
          } catch (e) {
            resolve([]);
          }
        });

        if (chunks.length >= meta.chunkCount) {
          chunks.sort((a, b) => a.index - b.index);
          const parts = chunks.map(c => c.data);
          return new Blob(parts, { type: meta.mimeType || 'audio/mp4' });
        }
      }
    }

    // 2. Fallback to legacy v1 store
    if (db.objectStoreNames.contains(IDB_STORE_EPISODES)) {
      const legacyRecord = await new Promise(resolve => {
        try {
          const tx = db.transaction(IDB_STORE_EPISODES, 'readonly');
          const req = tx.objectStore(IDB_STORE_EPISODES).get(episodeId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
      if (legacyRecord && legacyRecord.blob instanceof Blob) {
        return legacyRecord.blob;
      }
    }

    return null;
  }

  async function deleteOfflineEpisodeById(episodeId) {
    removeCachedOfflineMetaEntry(episodeId);
    state.offlineEpisodeIds.delete(episodeId);
    updateOfflineCountUI();

    const db = await openDatabase();
    if (!db) return true;

    return new Promise(resolve => {
      try {
        const storeNames = [IDB_STORE_EPISODES];
        if (db.objectStoreNames.contains(IDB_STORE_META)) storeNames.push(IDB_STORE_META);
        if (db.objectStoreNames.contains(IDB_STORE_CHUNKS)) storeNames.push(IDB_STORE_CHUNKS);

        const tx = db.transaction(storeNames, 'readwrite');
        tx.objectStore(IDB_STORE_EPISODES).delete(episodeId);

        if (db.objectStoreNames.contains(IDB_STORE_META)) {
          tx.objectStore(IDB_STORE_META).delete(episodeId);
        }
        if (db.objectStoreNames.contains(IDB_STORE_CHUNKS)) {
          const chunkStore = tx.objectStore(IDB_STORE_CHUNKS);
          const idx = chunkStore.index('by_episode');
          const cursorReq = idx.openKeyCursor(IDBKeyRange.only(episodeId));
          cursorReq.onsuccess = e => {
            const cursor = e.target.result;
            if (cursor) {
              chunkStore.delete(cursor.primaryKey);
              cursor.continue();
            }
          };
        }

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
        tx.onabort = () => resolve(false);
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function clearAllOfflineEpisodes() {
    try {
      localStorage.removeItem(STORAGE_OFFLINE_META_KEY);
    } catch (e) {}
    state.offlineEpisodeIds.clear();
    state.offlineIdAliasMap.clear();
    state.downloadingEpisodes.clear();
    state.downloadQueue = [];
    updateOfflineCountUI();

    const db = await openDatabase();
    if (!db) return;
    return new Promise(resolve => {
      try {
        const storeNames = [IDB_STORE_EPISODES];
        if (db.objectStoreNames.contains(IDB_STORE_META)) storeNames.push(IDB_STORE_META);
        if (db.objectStoreNames.contains(IDB_STORE_CHUNKS)) storeNames.push(IDB_STORE_CHUNKS);

        const tx = db.transaction(storeNames, 'readwrite');
        for (const name of storeNames) {
          tx.objectStore(name).clear();
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  function updateOfflineCountUI() {
    const count = state.offlineEpisodeIds.size;
    offlineStorageCount.textContent = `${count} ${count === 1 ? 'episodio guardado' : 'episodios guardados'} en memoria interna`;
    if (count > 0) {
      clearOfflineStorageBtn.classList.remove('hidden');
    } else {
      clearOfflineStorageBtn.classList.add('hidden');
    }

    const label = document.getElementById('downloadAllLibraryLabel');
    if (label && state.topics.length > 0 && !state.isProcessingQueue) {
      let pendingCount = 0;
      for (const t of state.topics) {
        for (const ep of t.episodes) {
          if (!state.offlineEpisodeIds.has(ep.id)) pendingCount++;
        }
      }
      if (pendingCount === 0 && count > 0) {
        label.textContent = `✓ Todo al día (${count} episodios en memoria)`;
      } else if (count > 0 && pendingCount > 0) {
        label.textContent = `Guardar solo ${pendingCount} faltante(s) (${count} ya en memoria)`;
      } else {
        label.textContent = `Guardar TODOS los temas (${pendingCount} episodios)`;
      }
    }
  }

  // ============================================================
  // LIBRARY LOADING (LOCAL-FIRST, MOBILE INDEPENDENT & MERGED IDB)
  // ============================================================
  function populateImportTopicSelect() {
    const sel = document.getElementById('importTopicSelect');
    if (!sel) return;
    const currentVal = sel.value;
    sel.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '— Elige una carpeta —';
    sel.appendChild(defaultOpt);

    for (const t of state.topics) {
      const opt = document.createElement('option');
      opt.value = t.name;
      opt.textContent = `${t.name} (${(t.episodes || []).length} audios)`;
      sel.appendChild(opt);
    }

    const newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '＋ Crear nueva carpeta...';
    sel.appendChild(newOpt);

    if (currentVal && Array.from(sel.options).some(o => o.value === currentVal)) {
      sel.value = currentVal;
    } else if (state.selectedTopicId) {
      const activeTopic = state.topics.find(t => t.id === state.selectedTopicId);
      if (activeTopic) sel.value = activeTopic.name;
    }
  }

  async function loadLibrary(isUserTriggered = false) {
    let serverTopics = [];
    let connectedToServer = false;
    const isHttpProtocol = location.protocol.startsWith('http');

    // Hydrate offlineEpisodeIds synchronously from localStorage cache (0ms delay)
    const instantMeta = loadCachedOfflineMetaMap();
    for (const id of Object.keys(instantMeta)) {
      state.offlineEpisodeIds.add(id);
      state.offlineIdAliasMap.set(id, id);
    }

    // 1. Gather pre-indexed static catalog and cached catalog
    let cachedTopics = [];
    try {
      const cachedRaw = localStorage.getItem(STORAGE_CACHED_CATALOG_KEY);
      if (cachedRaw) {
        cachedTopics = JSON.parse(cachedRaw) || [];
      }
    } catch (e) {}

    let localCatalogTopics = [];
    if (Array.isArray(window.__LOCAL_CATALOG__)) {
      localCatalogTopics = window.__LOCAL_CATALOG__.map(t => ({
        ...t,
        episodes: (t.episodes || []).map(ep => ({
          ...ep,
          url: isHttpProtocol ? (ep.url || ep.relativeUrl) : (ep.relativeUrl || ep.url)
        }))
      }));
    }

    // Intelligently merge cachedTopics and localCatalogTopics
    const preloadMap = new Map();
    for (const t of localCatalogTopics) {
      if (t && t.name) preloadMap.set(t.name, t);
    }
    for (const t of cachedTopics) {
      if (t && t.name) {
        if (!preloadMap.has(t.name)) {
          preloadMap.set(t.name, t);
        } else {
          const existing = preloadMap.get(t.name);
          if ((t.episodes || []).length > (existing.episodes || []).length) {
            preloadMap.set(t.name, t);
          }
        }
      }
    }
    serverTopics = Array.from(preloadMap.values());

    const buildSortedTopicsArray = (sourceMap = topicMap) =>
      Array.from(sourceMap.values())
        .sort((a, b) => naturalCollator.compare(a.name, b.name))
        .map(t => {
          const episodes = Array.from(t.episodesMap.values())
            .sort((a, b) => naturalCollator.compare(a.fileName || a.title, b.fileName || b.title))
            .map((ep, idx) => ({
              ...ep,
              episodeNumber: idx + 1
            }));
          return {
            id: t.id || `topic::${t.name}`,
            name: t.name,
            coverUrl: t.coverUrl || null,
            isCustom: Boolean(t.isCustom),
            episodeCount: episodes.length,
            episodes
          };
        });

    // 2. Try live Node.js server API ONLY on current origin (do NOT probe remote IP addresses that freeze or fail)
    if (isHttpProtocol) {
      const epUrl = `/api/library?_t=${Date.now()}`;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1800);
        const res = await fetch(epUrl, {
          cache: 'no-store',
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (res.ok) {
          const data = await res.json();
          if (data && Array.isArray(data.topics) && data.topics.length > 0) {
            serverTopics = data.topics.map(t => ({
              ...t,
              episodes: (t.episodes || []).map(ep => ({
                ...ep,
                url: ep.relativeUrl || ep.url
              }))
            }));
            connectedToServer = true;
            try {
              localStorage.setItem(STORAGE_CACHED_CATALOG_KEY, JSON.stringify(serverTopics));
            } catch (e) {}
          }
        }
      } catch (e) {}
    }

    // Build unified topics map:
    // A. Add server / base catalog topics
    const topicMap = new Map();
    for (const t of serverTopics) {
      topicMap.set(t.name, {
        id: `topic::${t.name}`,
        name: t.name,
        coverUrl: t.coverUrl || null,
        isCustom: false,
        episodesMap: new Map((t.episodes || []).map(ep => [ep.id, { ...ep }]))
      });
    }

    // B. Add all user-created custom folders (never deleted by server sync!)
    const customFolders = loadCustomFolders();
    for (const folderName of customFolders) {
      if (!topicMap.has(folderName)) {
        topicMap.set(folderName, {
          id: `topic::${folderName}`,
          name: folderName,
          coverUrl: null,
          isCustom: true,
          episodesMap: new Map()
        });
      } else {
        topicMap.get(folderName).isCustom = true;
      }
    }

    // C. Add all offline / imported episodes from IndexedDB (GUARANTEED TO NEVER DISAPPEAR!)
    const offlineRecords = await getAllOfflineEpisodes();
    const nextOfflineIds = new Set();
    const nextAliasMap = new Map();

    const exactServerEpMap = new Map();
    const byFileNameMap = new Map();
    const bySizeMap = new Map();

    for (const t of serverTopics) {
      for (const ep of t.episodes) {
        exactServerEpMap.set(ep.id, ep);
        const fnKey = (ep.fileName || '').toLowerCase();
        if (fnKey && !byFileNameMap.has(fnKey)) {
          byFileNameMap.set(fnKey, ep);
        }
        if (ep.size && ep.size > 0 && !bySizeMap.has(ep.size)) {
          bySizeMap.set(ep.size, ep);
        }
      }
    }

    let progressMigrated = false;

    for (const rec of offlineRecords) {
      if (!rec || !rec.id) continue;
      nextOfflineIds.add(rec.id);
      nextAliasMap.set(rec.id, rec.id);

      if (exactServerEpMap.has(rec.id)) {
        continue;
      }

      // Match renamed or relocated server audio
      const fnKey = (rec.fileName || '').toLowerCase();
      const recSize = rec.size || 0;
      const matchedEp = byFileNameMap.get(fnKey) || (recSize > 0 ? bySizeMap.get(recSize) : null);

      if (matchedEp) {
        nextOfflineIds.add(matchedEp.id);
        nextAliasMap.set(matchedEp.id, rec.id);

        if (state.progressMap[rec.id] && !state.progressMap[matchedEp.id]) {
          state.progressMap[matchedEp.id] = state.progressMap[rec.id];
          delete state.progressMap[rec.id];
          progressMigrated = true;
        }
        if (state.lastPlayed && state.lastPlayed.episodeId === rec.id) {
          saveLastPlayedToStorage(matchedEp.id, `topic::${matchedEp.topicName}`);
        }
        continue;
      }

      // Local imported file or custom audio: ALWAYS KEEP IT IN TOPIC MAP!
      const tName = rec.topicName || 'Mis Audios';
      if (!topicMap.has(tName)) {
        topicMap.set(tName, {
          id: `topic::${tName}`,
          name: tName,
          coverUrl: null,
          isCustom: true,
          episodesMap: new Map()
        });
      }
      const group = topicMap.get(tName);
      if (!group.episodesMap.has(rec.id)) {
        group.episodesMap.set(rec.id, {
          id: rec.id,
          topicName: tName,
          fileName: rec.fileName || rec.title,
          title: rec.title || cleanTitleFromFilename(rec.fileName || rec.id),
          episodeNumber: rec.episodeNumber || 1,
          size: recSize,
          source: 'local-file',
          hasOfflineBlob: true
        });
      }
    }

    if (progressMigrated) {
      saveProgressToStorage();
    }

    state.offlineEpisodeIds = nextOfflineIds;
    state.offlineIdAliasMap = nextAliasMap;
    state.topics = buildSortedTopicsArray(topicMap);
    updateOfflineCountUI();
    populateImportTopicSelect();

    if (connectedToServer) {
      connectionBadge.textContent = 'Carpeta AUDIOS sincronizada';
    } else {
      connectionBadge.textContent = 'Modo Celular Autónomo';
    }

    renderAll();
    return connectedToServer;
  }

  // ============================================================
  // DIRECT MOBILE FOLDER & FILES IMPORT (SAVED PERMANENTLY IN IDB)
  // ============================================================
  async function handleImportedFiles(fileList, isFolderSelection) {
    if (!fileList || fileList.length === 0) return;

    const audioExts = /\.(m4a|mp3|wav|ogg|oga|opus|aac|flac|mp4|webm)$/i;
    const validFiles = Array.from(fileList).filter(f => audioExts.test(f.name) || (f.type && f.type.startsWith('audio/')));

    if (validFiles.length === 0) {
      showToast('No se encontraron archivos de audio compatibles');
      return;
    }

    // Determine target topic
    let defaultTopicName = state.uploadTargetTopic || null;
    state.uploadTargetTopic = null;

    if (!defaultTopicName && state.selectedTopicId) {
      const activeTopic = state.topics.find(t => t.id === state.selectedTopicId);
      if (activeTopic) defaultTopicName = activeTopic.name;
    }

    if (!defaultTopicName) {
      const selectEl = document.getElementById('importTopicSelect');
      if (selectEl && selectEl.value && selectEl.value !== '__new__') {
        defaultTopicName = selectEl.value;
      }
    }

    if (!defaultTopicName && !isFolderSelection) {
      const sampleName = validFiles[0].name.replace(/\.[^/.]+$/, '');
      const inferred = sampleName.replace(/[_\-\s]*\d+$/, '').trim() || 'Mis Audios';
      const userTopic = window.prompt('¿En qué carpeta deseas guardar estos audios?\n(Nombre de carpeta existente o nueva):', inferred);
      if (!userTopic || !userTopic.trim()) return;
      defaultTopicName = userTopic.trim();
    }

    if (!defaultTopicName) defaultTopicName = 'Mis Audios';

    saveCustomFolder(defaultTopicName);

    const persistInIDB = persistImportedCheckbox ? persistImportedCheckbox.checked : true;
    showToast(`Guardando ${validFiles.length} audio(s) en tu celular...`);

    const topicMap = new Map();
    for (const t of state.topics) {
      topicMap.set(t.name, {
        id: t.id,
        name: t.name,
        coverUrl: t.coverUrl,
        isCustom: t.isCustom,
        episodesMap: new Map((t.episodes || []).map(ep => [ep.id, { ...ep }]))
      });
    }

    for (const file of validFiles) {
      let topicName = defaultTopicName;
      if (isFolderSelection && file.webkitRelativePath) {
        const parts = file.webkitRelativePath.split('/').filter(Boolean);
        if (parts.length >= 2) {
          topicName = parts[parts.length - 2];
        }
      }

      saveCustomFolder(topicName);

      const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const episodeId = `local::${topicName}::${cleanFileName}`;
      const epObj = {
        id: episodeId,
        topicName: topicName,
        fileName: file.name,
        title: cleanTitleFromFilename(file.name),
        size: file.size,
        fileObject: file,
        source: 'local-file',
        hasOfflineBlob: true
      };

      if (persistInIDB) {
        await saveEpisodeToIndexedDB({
          id: episodeId,
          topicName: topicName,
          fileName: file.name,
          title: epObj.title,
          size: file.size,
          blob: file,
          savedAt: Date.now()
        });
      }

      state.offlineEpisodeIds.add(episodeId);
      state.offlineIdAliasMap.set(episodeId, episodeId);

      if (!topicMap.has(topicName)) {
        topicMap.set(topicName, {
          id: `topic::${topicName}`,
          name: topicName,
          coverUrl: null,
          isCustom: true,
          episodesMap: new Map()
        });
      }

      const targetTopic = topicMap.get(topicName);
      targetTopic.episodesMap.set(episodeId, epObj);
    }

    // Re-build state.topics
    state.topics = Array.from(topicMap.values())
      .sort((a, b) => naturalCollator.compare(a.name, b.name))
      .map(t => {
        const episodes = Array.from(t.episodesMap.values())
          .sort((a, b) => naturalCollator.compare(a.fileName || a.title, b.fileName || b.title))
          .map((ep, idx) => ({ ...ep, episodeNumber: idx + 1 }));
        return {
          id: t.id || `topic::${t.name}`,
          name: t.name,
          coverUrl: t.coverUrl || null,
          isCustom: Boolean(t.isCustom),
          episodeCount: episodes.length,
          episodes
        };
      });

    closeModal('importModal');
    updateOfflineCountUI();
    populateImportTopicSelect();
    renderAll();

    // If currently viewing the topic we added audios to, refresh its detail view
    if (state.selectedTopicId) {
      const currentViewTopic = state.topics.find(t => t.id === state.selectedTopicId);
      if (currentViewTopic) {
        renderTopicDetail(currentViewTopic);
      }
    }

    showToast(`¡Listo! ${validFiles.length} audio(s) guardados en "${defaultTopicName}"`);
  }

  // ============================================================
  // STREAMING CHUNKED DOWNLOAD ENGINE & QUEUE FOR MOBILE
  // ============================================================
  function getDownloadUrlForEpisode(episode) {
    const isHttp = location.protocol.startsWith('http');
    let baseUrl = isHttp
      ? (episode.url || episode.relativeUrl)
      : (episode.relativeUrl || episode.url);

    if (!baseUrl && episode.topicName && episode.fileName) {
      baseUrl = `/audios/${encodeURIComponent(episode.topicName)}/${encodeURIComponent(episode.fileName)}`;
    }
    if (!baseUrl) return null;

    if (isHttp) {
      const sep = baseUrl.includes('?') ? '&' : '?';
      return `${baseUrl}${sep}dl=1`;
    }
    return baseUrl;
  }

  async function fetchAndStoreEpisodeChunked(episode, onProgress) {
    const db = await openDatabase();
    if (!db) return false;

    const downloadUrl = getDownloadUrlForEpisode(episode);
    if (!downloadUrl) return false;

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(downloadUrl, { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const contentLength = Number(res.headers.get('content-length')) || 0;
        const expectedBytes = contentLength > 0 ? contentLength : (episode.size || 0);
        const mimeType = res.headers.get('content-type') || 'audio/mp4';

        // If ReadableStream is supported and chunk store exists, stream in 4MB chunks directly to IndexedDB!
        if (
          res.body &&
          typeof res.body.getReader === 'function' &&
          db.objectStoreNames.contains(IDB_STORE_CHUNKS) &&
          db.objectStoreNames.contains(IDB_STORE_META)
        ) {
          const reader = res.body.getReader();
          let chunkIndex = 0;
          let receivedBytes = 0;
          let pendingChunks = [];
          let pendingSize = 0;

          const flushBufferToIDB = async () => {
            if (pendingSize === 0) return true;
            const merged = new Uint8Array(pendingSize);
            let pos = 0;
            for (const part of pendingChunks) {
              merged.set(part, pos);
              pos += part.byteLength;
            }
            pendingChunks = [];
            pendingSize = 0;
            const ok = await putChunkToIDB(db, episode.id, chunkIndex, merged);
            chunkIndex++;
            return ok;
          };

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              pendingChunks.push(value);
              pendingSize += value.byteLength;
              receivedBytes += value.byteLength;

              if (onProgress) {
                const pct = expectedBytes > 0
                  ? Math.min(99, Math.round((receivedBytes / expectedBytes) * 100))
                  : 50;
                onProgress(pct, receivedBytes, expectedBytes);
              }

              if (pendingSize >= OFFLINE_CHUNK_SIZE) {
                const ok = await flushBufferToIDB();
                if (!ok) throw new Error('IDB chunk write failed');
              }
            }
          }

          if (pendingSize > 0) {
            const ok = await flushBufferToIDB();
            if (!ok) throw new Error('IDB final chunk write failed');
          }

          // Verify complete file was received (prevent saving truncated downloads if Wi-Fi dropped)
          if (expectedBytes > 0 && receivedBytes < expectedBytes * 0.98) {
            throw new Error(`Truncated download (${receivedBytes} / ${expectedBytes})`);
          }
          if (receivedBytes === 0) {
            throw new Error('Empty response');
          }

          const metaRecord = {
            id: episode.id,
            topicName: episode.topicName,
            fileName: episode.fileName,
            title: episode.title,
            episodeNumber: episode.episodeNumber || 1,
            size: receivedBytes,
            mimeType: mimeType,
            chunkCount: chunkIndex,
            storageFormat: 'chunked-v2',
            savedAt: Date.now()
          };

          const metaOk = await putMetaToIDB(db, metaRecord);
          if (!metaOk) throw new Error('IDB meta write failed');

          saveCachedOfflineMetaEntry(metaRecord);
          state.offlineEpisodeIds.add(episode.id);
          state.offlineIdAliasMap.set(episode.id, episode.id);
          updateOfflineCountUI();
          if (onProgress) onProgress(100, receivedBytes, receivedBytes);
          return true;
        } else {
          // Fallback if ReadableStream is not available
          const blob = await res.blob();
          if (expectedBytes > 0 && blob.size < expectedBytes * 0.98) {
            throw new Error('Truncated blob');
          }
          const ok = await saveEpisodeToIndexedDB({
            id: episode.id,
            topicName: episode.topicName,
            fileName: episode.fileName,
            title: episode.title,
            episodeNumber: episode.episodeNumber || 1,
            size: blob.size,
            blob: blob,
            savedAt: Date.now()
          });
          if (!ok) throw new Error('Fallback save failed');
          if (onProgress) onProgress(100, blob.size, blob.size);
          return true;
        }
      } catch (err) {
        // Clean up any partial chunks before retrying
        await deleteOfflineEpisodeById(episode.id);
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 900 * attempt));
        }
      }
    }
    return false;
  }

  function updateEpisodeLiveDownloadDOM(episodeId) {
    const dlInfo = state.downloadingEpisodes.get(episodeId);
    const row = episodesListContainer
      ? episodesListContainer.querySelector(`.episode-item[data-ep-id="${CSS.escape(episodeId)}"]`)
      : null;

    if (row) {
      const chipEl = row.querySelector('.ep-download-status-slot');
      if (chipEl) {
        if (state.offlineEpisodeIds.has(episodeId)) {
          chipEl.innerHTML = '<span class="offline-chip">En memoria</span>';
        } else if (dlInfo) {
          const text = dlInfo.status === 'downloading'
            ? `⏳ ${dlInfo.pct}%`
            : '⏳ En cola';
          chipEl.innerHTML = `<span class="downloading-chip">${text}</span>`;
        } else {
          chipEl.innerHTML = '';
        }
      }
    }

    // Also update Topic Hero Download Button if we are inside a topic
    if (state.selectedTopicId) {
      const topic = state.topics.find(t => t.id === state.selectedTopicId);
      const topicBtn = document.getElementById('topicDownloadOfflineBtn');
      if (topic && topicBtn) {
        const total = topic.episodes.length;
        const savedCount = topic.episodes.filter(e => state.offlineEpisodeIds.has(e.id)).length;
        const activeInTopic = topic.episodes.filter(e => state.downloadingEpisodes.has(e.id));

        if (activeInTopic.length > 0) {
          const currentDl = activeInTopic.find(e => state.downloadingEpisodes.get(e.id)?.status === 'downloading') || activeInTopic[0];
          const info = state.downloadingEpisodes.get(currentDl.id);
          const pctStr = info && info.status === 'downloading' ? ` · ${info.pct}%` : '';
          topicBtn.classList.remove('saved');
          topicBtn.querySelector('span').textContent = `⏳ Guardando (${savedCount + 1}/${total})${pctStr}`;
        } else if (savedCount === total && total > 0) {
          topicBtn.classList.add('saved');
          topicBtn.querySelector('span').textContent = '✓ Guardado en celular';
        } else if (savedCount > 0) {
          topicBtn.classList.remove('saved');
          topicBtn.querySelector('span').textContent = `Guardar ${total - savedCount} faltante(s) en celular`;
        } else {
          topicBtn.classList.remove('saved');
          topicBtn.querySelector('span').textContent = 'Guardar en celular';
        }
      }
    }

    if (state.currentEpisode && state.currentEpisode.id === episodeId) {
      updateFullPlayerOfflineButton();
    }
  }

  function enqueueEpisodesForDownload(episodesList, onBatchProgress, onBatchDone) {
    let addedCount = 0;
    for (const ep of episodesList) {
      if (!ep || state.offlineEpisodeIds.has(ep.id)) continue;
      if (!state.downloadingEpisodes.has(ep.id)) {
        state.downloadingEpisodes.set(ep.id, {
          status: 'queued',
          pct: 0,
          loadedBytes: 0,
          totalBytes: ep.size || 0
        });
        state.downloadQueue.push({
          episode: ep,
          onBatchProgress,
          onBatchDone
        });
        addedCount++;
        updateEpisodeLiveDownloadDOM(ep.id);
      }
    }

    if (addedCount > 0 && !state.isProcessingQueue) {
      processDownloadQueue();
    }
    return addedCount;
  }

  async function processDownloadQueue() {
    if (state.isProcessingQueue) return;
    state.isProcessingQueue = true;
    await requestPersistentStorageAndWakeLock(true);

    let totalProcessedInRun = 0;
    let savedInRun = 0;
    let failedInRun = 0;
    let lastBatchDoneCallback = null;

    while (state.downloadQueue.length > 0) {
      const item = state.downloadQueue.shift();
      const { episode, onBatchProgress, onBatchDone } = item;
      if (onBatchDone) lastBatchDoneCallback = onBatchDone;

      if (state.offlineEpisodeIds.has(episode.id)) {
        state.downloadingEpisodes.delete(episode.id);
        updateEpisodeLiveDownloadDOM(episode.id);
        continue;
      }

      totalProcessedInRun++;
      const remainingAfterThis = state.downloadQueue.length;

      state.downloadingEpisodes.set(episode.id, {
        status: 'downloading',
        pct: 0,
        loadedBytes: 0,
        totalBytes: episode.size || 0
      });
      updateEpisodeLiveDownloadDOM(episode.id);

      const ok = await fetchAndStoreEpisodeChunked(episode, (pct, loaded, total) => {
        state.downloadingEpisodes.set(episode.id, {
          status: 'downloading',
          pct,
          loadedBytes: loaded,
          totalBytes: total
        });
        updateEpisodeLiveDownloadDOM(episode.id);
        if (onBatchProgress) {
          onBatchProgress({
            episode,
            pct,
            loadedBytes: loaded,
            totalBytes: total,
            completedCount: savedInRun,
            remainingCount: remainingAfterThis
          });
        }
      });

      state.downloadingEpisodes.delete(episode.id);

      if (ok) {
        savedInRun++;
      } else {
        failedInRun++;
      }

      // Immediately refresh UI for this completed episode so user sees "En memoria" right away!
      updateOfflineCountUI();
      renderAll();
      updateFullPlayerOfflineButton();
    }

    state.isProcessingQueue = false;
    await requestPersistentStorageAndWakeLock(false);
    updateOfflineCountUI();
    renderAll();

    if (lastBatchDoneCallback) {
      lastBatchDoneCallback({ savedInRun, failedInRun, totalProcessedInRun });
    } else if (totalProcessedInRun > 0) {
      if (failedInRun === 0) {
        showToast(`✓ ${savedInRun} ${savedInRun === 1 ? 'episodio guardado' : 'episodios guardados'} en la memoria del celular`);
      } else {
        showToast(`Se guardaron ${savedInRun} episodios (${failedInRun} fallaron, toca de nuevo para reintentar los faltantes)`);
      }
    }
  }

  // Save a single server episode into phone's IndexedDB for offline playback
  async function downloadEpisodeForOffline(episode) {
    if (!episode) return;
    if (state.offlineEpisodeIds.has(episode.id)) {
      const confirmRemove = window.confirm(`"${episode.title}" ya está guardado en la memoria del celular. ¿Deseas quitarlo de la memoria interna?`);
      if (confirmRemove) {
        const storedKey = state.offlineIdAliasMap.get(episode.id) || episode.id;
        await deleteOfflineEpisodeById(storedKey);
        state.offlineEpisodeIds.delete(episode.id);
        state.offlineIdAliasMap.delete(episode.id);
        updateOfflineCountUI();
        renderAll();
        updateFullPlayerOfflineButton();
        showToast('Episodio eliminado de la memoria interna');
      }
      return;
    }

    if (state.downloadingEpisodes.has(episode.id)) {
      const info = state.downloadingEpisodes.get(episode.id);
      showToast(`⏳ "${episode.title}" ya se está descargando (${info.pct || 0}%)...`);
      return;
    }

    showToast(`⏳ Descargando "${episode.title}" a la memoria del celular...`);
    enqueueEpisodesForDownload([episode]);
  }

  async function downloadEntireTopicOffline(topic) {
    if (!topic || !topic.episodes.length) return;
    const pending = topic.episodes.filter(ep => !state.offlineEpisodeIds.has(ep.id));
    if (pending.length === 0) {
      showToast('✓ Todos los episodios de este tema ya están guardados en el celular');
      return;
    }

    const added = enqueueEpisodesForDownload(pending);
    if (added > 0) {
      showToast(`⏳ Descargando ${added} episodio(s) de "${topic.name}"... No cierres el navegador.`);
    } else {
      showToast('⏳ Ya se están descargando los episodios de este tema...');
    }
  }

  // ============================================================
  // AUDIO PLAYBACK ENGINE & BACKGROUND MEDIA SESSION
  // ============================================================
  async function resolveEpisodePlayableUrl(episode) {
    if (state.activeBlobUrl) {
      URL.revokeObjectURL(state.activeBlobUrl);
      state.activeBlobUrl = null;
    }
    state.activeBlob = null; // Clear previous reference

    // 1. If user imported a direct File object in this session
    if (episode.fileObject instanceof Blob) {
      state.activeBlob = episode.fileObject;
      state.activeBlobUrl = URL.createObjectURL(episode.fileObject);
      return state.activeBlobUrl;
    }

    // 2. If episode is saved in IndexedDB (chunked v2 or legacy v1)
    if (state.offlineEpisodeIds.has(episode.id)) {
      const lookupId = state.offlineIdAliasMap.get(episode.id) || episode.id;
      const playableBlob = await getOfflineEpisodePlayableBlob(lookupId);
      if (playableBlob instanceof Blob) {
        state.activeBlob = playableBlob; // CRITICAL: Retains strong reference so Android V8 never GCs the audio buffer when screen turns off!
        state.activeBlobUrl = URL.createObjectURL(playableBlob);
        return state.activeBlobUrl;
      } else {
        // Record was missing or corrupted in IDB; remove stale flag so user can re-download
        state.offlineEpisodeIds.delete(episode.id);
        removeCachedOfflineMetaEntry(lookupId);
        updateOfflineCountUI();
        renderAll();
      }
    }

    // 3. Otherwise stream from server or local path
    const isHttp = location.protocol.startsWith('http');
    return isHttp ? (episode.url || episode.relativeUrl) : (episode.relativeUrl || episode.url);
  }

  function computeSmartRewindSeconds(lastUpdatedAt, isInitialLoad) {
    if (!lastUpdatedAt) return isInitialLoad ? 4 : 0;
    const elapsedSec = (Date.now() - lastUpdatedAt) / 1000;
    if (isInitialLoad) {
      return elapsedSec >= 300 ? 4 : 3;
    }
    if (elapsedSec < 20) return 0;
    if (elapsedSec < 300) return 3;
    return 4;
  }

  async function playEpisode(episode, topic, options = {}) {
    if (!episode) return;
    const { openFull = false, forceRestart = false } = options;

    const isSameEpisode = state.currentEpisode && state.currentEpisode.id === episode.id;
    if (isSameEpisode && !forceRestart) {
      togglePlayPause();
      if (openFull) openFullPlayer();
      return;
    }

    state.userRequestedPause = false;
    state.currentEpisode = episode;
    state.currentTopic = topic || state.topics.find(t => t.name === episode.topicName) || null;
    state.lastPausedAt = 0;
    updateBackdropMesh(state.currentTopic?.name || episode.topicName);

    if (state.currentTopic) {
      saveLastPlayedToStorage(episode.id, state.currentTopic.id);
    }

    const srcUrl = await resolveEpisodePlayableUrl(episode);
    const savedProg = getEpisodeProgress(episode.id);

    // Determine target start position with Smart Resume Rewind (-3s / -4s)
    let resumeTime = 0;
    let smartRewindApplied = 0;
    if (!forceRestart && savedProg.currentTime > 3) {
      // If it was at the very end (within 4 seconds of duration), start from 0
      if (savedProg.duration > 0 && savedProg.currentTime >= savedProg.duration - 4) {
        resumeTime = 0;
      } else {
        smartRewindApplied = computeSmartRewindSeconds(savedProg.updatedAt, true);
        resumeTime = Math.max(0, savedProg.currentTime - smartRewindApplied);
      }
    }

    audio.pause();
    audio.src = srcUrl;
    audio.playbackRate = state.playbackRate;
    audio.defaultPlaybackRate = state.playbackRate;
    if ('preservesPitch' in audio) audio.preservesPitch = true;
    if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;

    const applyResumeAndPlay = () => {
      if (resumeTime > 0 && (!audio.duration || resumeTime < audio.duration)) {
        try {
          audio.currentTime = resumeTime;
        } catch (e) {}
      }
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            state.isPlaying = true;
            state.userRequestedPause = false;
            updatePlaybackWakeLock(true);
            updatePlayerUI();
            setupMediaSession();
          })
          .catch(() => {
            state.isPlaying = false;
            updatePlaybackWakeLock(false);
            updatePlayerUI();
          });
      }
    };

    if (audio.readyState >= 1) {
      applyResumeAndPlay();
    } else {
      audio.addEventListener('loadedmetadata', applyResumeAndPlay, { once: true });
      audio.load();
    }

    if (savedProg.currentTime > 3 && ( resumeTime > 0 || smartRewindApplied > 0 )) {
      showToast(`⏪ Retomando en ${formatTime(resumeTime)} (-${smartRewindApplied}s para retomar el hilo)`);
    }

    miniPlayer.classList.remove('hidden');
    updatePlayerUI();
    renderAll();

    if (openFull) {
      openFullPlayer();
    }
  }

  function applySmartResumeBeforeUnpause() {
    if (!state.lastPausedAt || !audio.currentTime || audio.currentTime <= 4) return;
    const rewindSec = computeSmartRewindSeconds(state.lastPausedAt, false);
    if (rewindSec > 0) {
      const target = Math.max(0, audio.currentTime - rewindSec);
      try {
        audio.currentTime = target;
      } catch (e) {}
      showToast(`⏪ -${rewindSec}s para retomar el hilo (${formatTime(target)})`);
    }
    state.lastPausedAt = 0;
  }

  function togglePlayPause() {
    if (!state.currentEpisode) return;
    if (audio.paused) {
      state.userRequestedPause = false;
      applySmartResumeBeforeUnpause();
      audio.play().then(() => {
        state.isPlaying = true;
        updatePlaybackWakeLock(true);
        updatePlayerUI();
        updateMediaSessionPosition();
      }).catch(() => {
        showToast('No se pudo reproducir el archivo. Verifica la carpeta AUDIOS.');
      });
    } else {
      state.userRequestedPause = true;
      state.lastPausedAt = Date.now();
      audio.pause();
      state.isPlaying = false;
      updatePlaybackWakeLock(false);
      saveCurrentPlaybackPosition();
      updatePlayerUI();
    }
  }

  function skipSeconds(delta) {
    if (!state.currentEpisode || !Number.isFinite(audio.duration)) return;
    const target = Math.max(0, Math.min(audio.duration - 0.5, audio.currentTime + delta));
    audio.currentTime = target;
    saveCurrentPlaybackPosition();
    updateTimeDisplays(target, audio.duration);
    updateMediaSessionPosition();
  }

  function playAdjacentEpisode(direction) {
    if (!state.currentEpisode || !state.currentTopic) return;
    const list = state.currentTopic.episodes;
    const idx = list.findIndex(e => e.id === state.currentEpisode.id);
    if (idx < 0) return;
    const nextIdx = idx + direction;
    if (nextIdx >= 0 && nextIdx < list.length) {
      playEpisode(list[nextIdx], state.currentTopic, { openFull: false });
    } else if (direction > 0) {
      showToast('Has llegado al final de este tema');
    }
  }

  function saveCurrentPlaybackPosition() {
    if (!state.currentEpisode) return;
    const cur = audio.currentTime || 0;
    const dur = Number.isFinite(audio.duration) && audio.duration > 0
      ? audio.duration
      : getEpisodeProgress(state.currentEpisode.id).duration || 0;

    if (cur <= 0 && dur <= 0) return;

    const existing = getEpisodeProgress(state.currentEpisode.id);
    const isNearEnd = dur > 30 && cur >= dur - 5;

    updateEpisodeProgress(state.currentEpisode.id, {
      currentTime: cur,
      duration: dur,
      completed: existing.completed || isNearEnd
    });

    if (state.currentTopic) {
      saveLastPlayedToStorage(state.currentEpisode.id, state.currentTopic.id);
    }
  }

  // ============================================================
  // MEDIA SESSION API (LOCK SCREEN & BACKGROUND CONTROLS)
  // ============================================================
  function setupMediaSession() {
    if (!('mediaSession' in navigator) || !state.currentEpisode) return;

    const topicName = state.currentTopic ? state.currentTopic.name : state.currentEpisode.topicName;
    const artDataUrl = getLockScreenArtworkDataUrl(topicName, state.currentEpisode.title);

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: state.currentEpisode.title,
        artist: topicName,
        album: 'AuraCast Podcast',
        artwork: [
          { src: artDataUrl, sizes: '512x512', type: 'image/png' }
        ]
      });

      navigator.mediaSession.setActionHandler('play', () => {
        state.userRequestedPause = false;
        updatePlaybackWakeLock(true);
        applySmartResumeBeforeUnpause();
        audio.play();
      });
      navigator.mediaSession.setActionHandler('pause', () => {
        state.userRequestedPause = true;
        updatePlaybackWakeLock(false);
        state.lastPausedAt = Date.now();
        audio.pause();
      });
      navigator.mediaSession.setActionHandler('stop', () => {
        state.userRequestedPause = true;
        updatePlaybackWakeLock(false);
        audio.pause();
      });
      navigator.mediaSession.setActionHandler('seekbackward', details => {
        skipSeconds(-(details.seekOffset || 15));
      });
      navigator.mediaSession.setActionHandler('seekforward', details => {
        skipSeconds(details.seekOffset || 15);
      });
      navigator.mediaSession.setActionHandler('seekto', details => {
        if (details.seekTime !== undefined && Number.isFinite(details.seekTime)) {
          audio.currentTime = details.seekTime;
          saveCurrentPlaybackPosition();
          updateMediaSessionPosition();
        }
      });
      navigator.mediaSession.setActionHandler('previoustrack', () => {
        playAdjacentEpisode(-1);
      });
      navigator.mediaSession.setActionHandler('nexttrack', () => {
        playAdjacentEpisode(1);
      });
    } catch (e) {}

    updateMediaSessionPosition();
  }

  function updateMediaSessionPosition() {
    if (!('mediaSession' in navigator) || !('setPositionState' in navigator.mediaSession)) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;

    try {
      navigator.mediaSession.setPositionState({
        duration: audio.duration,
        playbackRate: audio.playbackRate || 1,
        position: Math.min(audio.duration, Math.max(0, audio.currentTime || 0))
      });
    } catch (e) {}
  }

  // ============================================================
  // AUDIO ELEMENT EVENT LISTENERS
  // ============================================================
  let lastSavedSecond = -1;

  audio.addEventListener('timeupdate', () => {
    if (!state.currentEpisode) return;
    const cur = audio.currentTime || 0;
    const dur = audio.duration || 0;

    if (!state.isScrubbing) {
      updateTimeDisplays(cur, dur);
    }

    // Save every second
    const secFloor = Math.floor(cur);
    if (secFloor !== lastSavedSecond) {
      lastSavedSecond = secFloor;
      saveCurrentPlaybackPosition();
      updateMediaSessionPosition();
    }
  });

  audio.addEventListener('loadedmetadata', () => {
    if (!state.currentEpisode) return;
    const dur = audio.duration || 0;
    const saved = getEpisodeProgress(state.currentEpisode.id);
    updateEpisodeProgress(state.currentEpisode.id, { duration: dur });
    updateTimeDisplays(audio.currentTime || saved.currentTime || 0, dur);
    updateMediaSessionPosition();
    renderAll();
  });

  audio.addEventListener('play', () => {
    state.isPlaying = true;
    state.userRequestedPause = false;
    resumeAudioAnalyser();
    updatePlaybackWakeLock(true);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
    updatePlayerUI();
  });

  audio.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlaybackWakeLock(false);
    if (!state.lastPausedAt) state.lastPausedAt = Date.now();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    saveCurrentPlaybackPosition();
    updatePlayerUI();
    renderAll();
  });

  audio.addEventListener('error', () => {
    const err = audio.error;
    console.warn('Audio playback error encountered:', err);
    // Auto-recover playback if Android put the network/blob resource in doze
    if (state.isPlaying && state.currentEpisode && state.recoveryAttempts < 3) {
      state.recoveryAttempts++;
      const savedTime = audio.currentTime || getEpisodeProgress(state.currentEpisode.id).currentTime || 0;
      setTimeout(async () => {
        try {
          const freshUrl = await resolveEpisodePlayableUrl(state.currentEpisode);
          audio.src = freshUrl;
          audio.currentTime = savedTime;
          await audio.play();
          state.recoveryAttempts = 0;
        } catch (e) {
          console.warn('Auto-recovery attempt failed:', e);
        }
      }, 350);
    }
  });

  audio.addEventListener('stalled', () => {
    if (state.isPlaying && audio.paused && !state.userRequestedPause) {
      audio.play().catch(() => {});
    }
  });

  audio.addEventListener('waiting', () => {
    // Media element is buffering
  });

  audio.addEventListener('ended', () => {
    if (!state.currentEpisode) return;
    updatePlaybackWakeLock(false);
    const dur = audio.duration || getEpisodeProgress(state.currentEpisode.id).duration || 0;
    updateEpisodeProgress(state.currentEpisode.id, {
      currentTime: dur,
      duration: dur,
      completed: true
    });

    // Check if sleep timer was set to 'end-of-episode'
    if (state.sleepTimer.mode === 'end-of-episode') {
      cancelSleepTimer();
      state.isPlaying = false;
      updatePlayerUI();
      renderAll();
      showToast('🌙 Temporizador: Episodio finalizado');
      return;
    }

    renderAll();
    // Auto-advance to next episode in topic
    if (state.currentTopic) {
      const eps = state.currentTopic.episodes;
      const idx = eps.findIndex(e => e.id === state.currentEpisode.id);
      if (idx >= 0 && idx + 1 < eps.length) {
        showToast(`Reproduciendo siguiente: ${eps[idx + 1].title}`);
        playEpisode(eps[idx + 1], state.currentTopic, { openFull: false, forceRestart: true });
        return;
      }
    }
    state.isPlaying = false;
    updatePlayerUI();
  });

  // Save position and manage background lifecycle when user locks phone or switches app
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      saveCurrentPlaybackPosition();
    } else {
      resumeAudioAnalyser();
      if (state.isPlaying) {
        updatePlaybackWakeLock(true);
        if (audio.paused && !state.userRequestedPause) {
          // If system suspended audio while screen was off, resume seamlessly
          audio.play().catch(() => {});
        }
      }
      if (!fullPlayerOverlay.classList.contains('hidden') && state.appearance.animatedArt) {
        startVisualizerLoop();
      }
    }
  });
  window.addEventListener('pagehide', saveCurrentPlaybackPosition);
  window.addEventListener('beforeunload', saveCurrentPlaybackPosition);

  // ============================================================
  // SLEEP TIMER
  // ============================================================
  function setSleepTimer(optionValue) {
    cancelSleepTimer();
    audio.volume = 1;

    if (optionValue === '0' || !optionValue) {
      showToast('Temporizador desactivado');
      updateSleepTimerUI();
      return;
    }

    if (optionValue === 'end-of-episode') {
      state.sleepTimer.mode = 'end-of-episode';
      showToast('🌙 El audio se detendrá al terminar este episodio');
      updateSleepTimerUI();
      return;
    }

    const mins = parseInt(optionValue, 10);
    if (isNaN(mins) || mins <= 0) return;

    state.sleepTimer.mode = 'countdown';
    state.sleepTimer.endsAt = Date.now() + mins * 60 * 1000;

    state.sleepTimer.intervalId = setInterval(() => {
      const remainingMs = state.sleepTimer.endsAt - Date.now();
      if (remainingMs <= 0) {
        audio.pause();
        audio.volume = 1;
        saveCurrentPlaybackPosition();
        cancelSleepTimer();
        showToast('🌙 Temporizador finalizado. Progreso guardado.');
        return;
      }
      // Gentle volume fade out in last 10 seconds
      if (remainingMs < 10000) {
        audio.volume = Math.max(0.1, remainingMs / 10000);
      }
      updateSleepTimerUI();
    }, 1000);

    showToast(`🌙 Temporizador activado: ${mins} min`);
    updateSleepTimerUI();
  }

  function cancelSleepTimer() {
    if (state.sleepTimer.intervalId) {
      clearInterval(state.sleepTimer.intervalId);
    }
    state.sleepTimer.mode = null;
    state.sleepTimer.endsAt = null;
    state.sleepTimer.intervalId = null;
    audio.volume = 1;
    updateSleepTimerUI();
  }

  function updateSleepTimerUI() {
    if (!state.sleepTimer.mode) {
      fpSleepActivePill.classList.add('hidden');
      fpSleepBtn.classList.remove('active');
      fpSleepCaption.textContent = 'Temporizador';
      return;
    }

    fpSleepBtn.classList.add('active');
    fpSleepActivePill.classList.remove('hidden');

    if (state.sleepTimer.mode === 'end-of-episode') {
      fpSleepActivePill.textContent = '🌙 Para al fin del episodio';
      fpSleepCaption.textContent = 'Fin ep.';
    } else if (state.sleepTimer.endsAt) {
      const remSec = Math.max(0, Math.ceil((state.sleepTimer.endsAt - Date.now()) / 1000));
      const formatted = formatTime(remSec);
      fpSleepActivePill.textContent = `🌙 Apagado en ${formatted}`;
      fpSleepCaption.textContent = formatted;
    }
  }

  // ============================================================
  // UI RENDERING
  // ============================================================
  function getTopicStats(topic) {
    let completedCount = 0;
    let inProgressCount = 0;
    let totalRatio = 0;

    for (const ep of topic.episodes) {
      const p = getEpisodeProgress(ep.id);
      if (p.completed) {
        completedCount++;
        totalRatio += 1;
      } else if (p.currentTime > 3) {
        inProgressCount++;
        if (p.duration > 0) {
          totalRatio += Math.min(0.99, p.currentTime / p.duration);
        } else {
          totalRatio += 0.25;
        }
      }
    }

    const percent = topic.episodes.length > 0
      ? Math.round((totalRatio / topic.episodes.length) * 100)
      : 0;

    return {
      completedCount,
      inProgressCount,
      percent
    };
  }

  function renderAll() {
    renderContinueListeningCard();
    renderLibraryStats();
    renderTopicsGrid();
    if (state.selectedTopicId) {
      const topic = state.topics.find(t => t.id === state.selectedTopicId);
      if (topic) {
        renderTopicDetail(topic);
      }
    }
  }

  function renderContinueListeningCard() {
    let targetEp = null;
    let targetTopic = null;

    if (state.lastPlayed && state.lastPlayed.episodeId) {
      for (const t of state.topics) {
        const found = t.episodes.find(e => e.id === state.lastPlayed.episodeId);
        if (found) {
          targetEp = found;
          targetTopic = t;
          break;
        }
      }
    }

    // If no lastPlayed, find the most recently updated episode in progressMap
    if (!targetEp) {
      let bestTime = 0;
      for (const t of state.topics) {
        for (const ep of t.episodes) {
          const p = state.progressMap[ep.id];
          if (p && p.currentTime > 3 && p.updatedAt > bestTime) {
            bestTime = p.updatedAt;
            targetEp = ep;
            targetTopic = t;
          }
        }
      }
    }

    if (!targetEp || !targetTopic) {
      continueListeningContainer.classList.add('hidden');
      return;
    }

    const prog = getEpisodeProgress(targetEp.id);
    const pct = prog.duration > 0 ? Math.min(100, Math.round((prog.currentTime / prog.duration) * 100)) : 0;
    const remaining = prog.duration > prog.currentTime
      ? `Restan ${ formatTime(prog.duration - prog.currentTime) }`
      : '';

    continueListeningContainer.classList.remove('hidden');
    continueListeningContainer.innerHTML = `
      <div class="continue-card">
        <div class="continue-badge-row">
          <span class="continue-pill">● Continuar escuchando</span>
          <span class="continue-time-saved">Quedaste en ${formatTime(prog.currentTime)} ${remaining ? '· ' + remaining : ''}</span>
        </div>
        <div class="continue-body">
          <div class="continue-art">
            ${renderTopicArtworkSVG(targetTopic.name, targetTopic.coverUrl)}
          </div>
          <div class="continue-info">
            <div class="continue-ep-title">${targetEp.title}</div>
            <div class="continue-topic-name">📁 ${targetTopic.name} · Episodio ${targetEp.episodeNumber}</div>
            <div class="continue-progress-bar">
              <div class="continue-progress-fill" style="width: ${pct}%"></div>
            </div>
          </div>
          <button class="continue-play-btn" id="resumeHeroBtn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>Retomar</span>
          </button>
        </div>
      </div>
    `;

    const resumeBtn = document.getElementById('resumeHeroBtn');
    if (resumeBtn) {
      resumeBtn.addEventListener('click', () => {
        playEpisode(targetEp, targetTopic, { openFull: true });
      });
    }
  }

  function renderLibraryStats() {
    let totalTopics = state.topics.length;
    let totalEpisodes = 0;
    let completedEpisodes = 0;

    for (const t of state.topics) {
      totalEpisodes += t.episodes.length;
      for (const ep of t.episodes) {
        if (getEpisodeProgress(ep.id).completed) {
          completedEpisodes++;
        }
      }
    }

    libraryStats.innerHTML = `
      <div class="stat-box">
        <span class="stat-value">${totalTopics}</span>
        <span class="stat-label">${totalTopics === 1 ? 'Tema (Carpeta)' : 'Temas (Carpetas)'}</span>
      </div>
      <div class="stat-box">
        <span class="stat-value">${totalEpisodes}</span>
        <span class="stat-label">Episodios totales</span>
      </div>
      <div class="stat-box">
        <span class="stat-value">${completedEpisodes}/${totalEpisodes}</span>
        <span class="stat-label">Completados</span>
      </div>
    `;
  }

  function renderTopicsGrid() {
    const q = state.searchQuery.trim().toLowerCase();

    let hiddenCompletedCount = 0;
    const filtered = state.topics.filter(topic => {
      const stats = getTopicStats(topic);
      const isFinished = topic.episodes.length > 0 && stats.completedCount === topic.episodes.length;
      if (state.appearance.hideCompleted && isFinished && state.activeFilter !== 'completed') {
        hiddenCompletedCount++;
        return false;
      }
      if (state.activeFilter === 'in-progress' && stats.inProgressCount === 0 && (stats.completedCount === 0 || stats.completedCount === topic.episodes.length)) {
        return false;
      }
      if (state.activeFilter === 'completed' && (topic.episodes.length === 0 || stats.completedCount < topic.episodes.length)) {
        return false;
      }
      if (state.activeFilter === 'offline') {
        const hasOffline = topic.episodes.some(ep => state.offlineEpisodeIds.has(ep.id));
        if (!hasOffline) return false;
      }

      if (!q) return true;
      if (topic.name.toLowerCase().includes(q)) return true;
      return topic.episodes.some(ep => ep.title.toLowerCase().includes(q) || ep.fileName.toLowerCase().includes(q));
    });

    topicsCountBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'tema' : 'temas'}`
      + (hiddenCompletedCount > 0 ? ` · ${hiddenCompletedCount} ${hiddenCompletedCount === 1 ? 'terminado oculto' : 'terminados ocultos'}` : '');
    const layout = ['grid', 'carousel', 'list'].includes(state.appearance.libraryLayout) ? state.appearance.libraryLayout : 'grid';
    topicsGrid.className = `topics-grid layout-${layout}`;

    if (filtered.length === 0) {
      topicsGrid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1; text-align: center; padding: 48px 16px;">
          <h3 style="font-size: 1.25rem; font-weight: 700; margin-bottom: 8px;">Tu biblioteca está vacía</h3>
          <p style="color: var(--text-secondary); font-size: 0.95rem; margin-bottom: 20px;">Crea tu primera carpeta para organizar y guardar tus audios.</p>
          <button class="btn-primary" id="emptyCreateTopicBtn" style="max-width:240px; margin: 0 auto; display: inline-flex;">
            + Crear nueva carpeta
          </button>
        </div>
      `;
      const btn = document.getElementById('emptyCreateTopicBtn');
      if (btn) btn.addEventListener('click', () => promptCreateNewFolder());
      return;
    }

    const quickPlayBtn = topic => `
      <button class="topic-quick-play" data-quick-play="${topic.id}" title="Reproducir o retomar este tema" aria-label="Reproducir tema">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <polygon points="6 4 20 12 6 20 6 4"/>
        </svg>
      </button>`;

    const progressRing = percent => {
      if (percent <= 0) return '';
      if (percent >= 100) {
        return `<span class="topic-ring is-done" aria-label="Tema terminado"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17 19 7.5"/></svg></span>`;
      }
      const circ = 2 * Math.PI * 10;
      return `<span class="topic-ring" aria-label="${percent}% escuchado"><svg viewBox="0 0 26 26" width="28" height="28"><circle cx="13" cy="13" r="10" fill="rgba(0,0,0,0.45)" stroke="rgba(255,255,255,0.25)" stroke-width="3"/><circle cx="13" cy="13" r="10" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-dasharray="${(circ * percent / 100).toFixed(1)} ${circ.toFixed(1)}" transform="rotate(-90 13 13)"/></svg></span>`;
    };

    const episodesLabel = topic => `${topic.episodes.length} ${topic.episodes.length === 1 ? 'episodio' : 'episodios'}`;

    const gridCard = topic => {
      const stats = getTopicStats(topic);
      return `
        <article class="topic-card" data-topic-id="${topic.id}">
          <div class="topic-card-art">
            ${renderTopicArtworkSVG(topic.name, topic.coverUrl)}
            ${progressRing(stats.percent)}
            ${quickPlayBtn(topic)}
          </div>
          <div class="topic-card-body">
            <h3 class="topic-card-title">${topic.name}</h3>
            <div class="topic-card-meta">
              <span>${episodesLabel(topic)}</span>
              <span>·</span>
              <span>${stats.completedCount}/${topic.episodes.length} vistos</span>
            </div>
          </div>
        </article>
      `;
    };

    const listRow = topic => {
      const stats = getTopicStats(topic);
      return `
        <article class="topic-card topic-row" data-topic-id="${topic.id}">
          <div class="topic-card-art">${renderTopicArtworkSVG(topic.name, topic.coverUrl)}</div>
          <div class="topic-row-body">
            <h3 class="topic-card-title">${topic.name}</h3>
            <div class="topic-card-meta">
              <span>${episodesLabel(topic)}</span>
              <span>·</span>
              <span>${stats.percent}%</span>
            </div>
            <div class="topic-progress-track">
              <div class="topic-progress-fill" style="width: ${stats.percent}%"></div>
            </div>
          </div>
          ${quickPlayBtn(topic)}
        </article>
      `;
    };

    if (layout === 'list') {
      topicsGrid.innerHTML = filtered.map(listRow).join('');
    } else if (layout === 'carousel') {
      const shelves = [
        ['En curso', filtered.filter(t => { const p = getTopicStats(t).percent; return p > 0 && p < 100; })],
        ['Por empezar', filtered.filter(t => getTopicStats(t).percent === 0)],
        ['Terminados', filtered.filter(t => getTopicStats(t).percent >= 100)]
      ].filter(([, items]) => items.length > 0);
      topicsGrid.innerHTML = shelves.map(([title, items]) => `
        <section class="lib-shelf">
          <h3 class="lib-shelf-title">${title}<span>${items.length}</span></h3>
          <div class="lib-shelf-row">${items.map(gridCard).join('')}</div>
        </section>
      `).join('');
    } else {
      topicsGrid.innerHTML = filtered.map(gridCard).join('');
    }

    topicsGrid.querySelectorAll('.topic-card').forEach(card => {
      card.addEventListener('click', e => {
        const quickBtn = e.target.closest('[data-quick-play]');
        const topicId = card.getAttribute('data-topic-id');
        const topic = state.topics.find(t => t.id === topicId);
        if (!topic) return;

        if (quickBtn) {
          e.stopPropagation();
          playOrResumeTopic(topic);
        } else {
          openTopicView(topic.id);
        }
      });
    });
  }

  function playOrResumeTopic(topic) {
    if (!topic || !topic.episodes.length) return;
    // Find first episode in progress, or first uncompleted episode, or episode 1
    let target = topic.episodes.find(ep => {
      const p = getEpisodeProgress(ep.id);
      return p.currentTime > 3 && !p.completed;
    });
    if (!target) {
      target = topic.episodes.find(ep => !getEpisodeProgress(ep.id).completed);
    }
    if (!target) {
      target = topic.episodes[0];
    }
    playEpisode(target, topic, { openFull: true });
  }

  function openTopicView(topicId) {
    const topic = state.topics.find(t => t.id === topicId);
    if (!topic) return;
    state.selectedTopicId = topicId;
    homeView.classList.add('hidden');
    topicDetailView.classList.remove('hidden');
    const backBtn = document.getElementById('backToTopicsBtn');
    if (backBtn) backBtn.classList.remove('hidden');
    const navTitle = document.getElementById('navSmallTitle');
    if (navTitle) navTitle.textContent = topic.name;
    renderTopicDetail(topic);
    document.getElementById('mainContent').scrollTop = 0;
  }

  function closeTopicView() {
    state.selectedTopicId = null;
    topicDetailView.classList.add('hidden');
    homeView.classList.remove('hidden');
    const backBtn = document.getElementById('backToTopicsBtn');
    if (backBtn) backBtn.classList.add('hidden');
    const navTitle = document.getElementById('navSmallTitle');
    if (navTitle) navTitle.textContent = 'Biblioteca';
    renderAll();
  }

  function renderTopicDetail(topic) {
    const stats = getTopicStats(topic);
    const totalTopicEps = topic.episodes.length;
    const savedTopicEps = topic.episodes.filter(ep => state.offlineEpisodeIds.has(ep.id)).length;
    const activeInTopic = topic.episodes.filter(ep => state.downloadingEpisodes.has(ep.id));
    const allOffline = totalTopicEps > 0 && savedTopicEps === totalTopicEps;

    let downloadBtnText = 'Guardar en celular';
    if (activeInTopic.length > 0) {
      const currentDl = activeInTopic.find(e => state.downloadingEpisodes.get(e.id)?.status === 'downloading') || activeInTopic[0];
      const info = state.downloadingEpisodes.get(currentDl.id);
      const pctStr = info && info.status === 'downloading' ? ` · ${info.pct}%` : '';
      downloadBtnText = `⏳ Guardando (${savedTopicEps + 1}/${totalTopicEps})${pctStr}`;
    } else if (allOffline) {
      downloadBtnText = '✓ Guardado en celular';
    } else if (savedTopicEps > 0) {
      downloadBtnText = `Guardar ${totalTopicEps - savedTopicEps} faltantes`;
    }

    // Determine primary button label
    const resumeCandidate = topic.episodes.find(ep => {
      const p = getEpisodeProgress(ep.id);
      return p.currentTime > 3 && !p.completed;
    });

    const primaryBtnText = resumeCandidate
      ? `Retomar ep. ${resumeCandidate.episodeNumber} · ${formatTime(getEpisodeProgress(resumeCandidate.id).currentTime)}`
      : 'Reproducir tema';

    topicHeroContainer.innerHTML = `
      <div class="topic-hero-top">
        <div class="topic-hero-art">
          ${renderTopicArtworkSVG(topic.name, topic.coverUrl)}
        </div>
        <div class="topic-hero-info">
          <div class="topic-hero-badge">${topic.isCustom ? 'CARPETA CREADA' : 'CARPETA DE TEMA'}</div>
          <h1 class="topic-hero-title">${topic.name}</h1>
          <div class="topic-hero-sub">
            ${topic.episodes.length} episodios · ${stats.completedCount} completados (${stats.percent}%) · ${savedTopicEps}/${totalTopicEps} en memoria
          </div>
          <div class="topic-progress-row" style="margin-top:10px;">
            <div class="topic-progress-track">
              <div class="topic-progress-fill" style="width: ${stats.percent}%"></div>
            </div>
          </div>
        </div>
      </div>
      <div class="topic-hero-actions">
        ${topic.episodes.length > 0 ? `
          <button class="btn-primary-gold" id="topicPlayResumeBtn">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"/>
            </svg>
            <span>${primaryBtnText}</span>
          </button>
        ` : ''}

        <button class="btn-secondary-glass" id="topicAddAudiosBtn" title="Cargar audios desde tu celular a esta carpeta">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.3">
            <line x1="12" y1="5" x2="12" y2="19"/>
            <line x1="5" y1="12" x2="19" y2="12"/>
          </svg>
          <span>+ Cargar audios</span>
        </button>

        ${totalTopicEps > 0 && !allOffline ? `
          <button class="btn-secondary-glass ${allOffline ? 'saved' : ''}" id="topicDownloadOfflineBtn">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
            <span>${downloadBtnText}</span>
          </button>
        ` : ''}

        ${topic.isCustom || totalTopicEps === 0 ? `
          <button class="btn-danger-glass" id="topicDeleteFolderBtn" title="Eliminar esta carpeta">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="3 6 5 6 21 6"/>
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
            </svg>
            <span>Eliminar</span>
          </button>
        ` : ''}
      </div>
    `;

    const playResumeBtn = document.getElementById('topicPlayResumeBtn');
    if (playResumeBtn) {
      playResumeBtn.addEventListener('click', () => {
        playOrResumeTopic(topic);
      });
    }

    const addAudiosBtn = document.getElementById('topicAddAudiosBtn');
    if (addAudiosBtn) {
      addAudiosBtn.addEventListener('click', () => {
        state.uploadTargetTopic = topic.name;
        filesPickerInput.click();
      });
    }

    const dlOfflineBtn = document.getElementById('topicDownloadOfflineBtn');
    if (dlOfflineBtn) {
      dlOfflineBtn.addEventListener('click', () => {
        downloadEntireTopicOffline(topic);
      });
    }

    const deleteFolderBtn = document.getElementById('topicDeleteFolderBtn');
    if (deleteFolderBtn) {
      deleteFolderBtn.addEventListener('click', async () => {
        if (window.confirm(`¿Deseas eliminar la carpeta "${topic.name}" y todos sus audios?`)) {
          for (const ep of topic.episodes) {
            await deleteOfflineEpisodeById(ep.id);
          }
          deleteCustomFolder(topic.name);
          state.topics = state.topics.filter(t => t.id !== topic.id);
          closeTopicView();
          showToast(`Carpeta "${topic.name}" eliminada`);
        }
      });
    }

    episodesListCount.textContent = `Episodios (${topic.episodes.length})`;

    if (topic.episodes.length === 0) {
      episodesListContainer.innerHTML = `
        <div class="empty-topic-state">
          <p>Esta carpeta no tiene audios todavía.<br>Puedes cargar archivos de audio desde tu celular para escucharlos sin conexión.</p>
          <button type="button" class="btn-primary" id="emptyTopicAddBtn" style="margin:0 auto;max-width:240px;">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.3">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
            <span>+ Cargar audios aquí</span>
          </button>
        </div>
      `;
      const emptyAddBtn = document.getElementById('emptyTopicAddBtn');
      if (emptyAddBtn) {
        emptyAddBtn.addEventListener('click', () => {
          state.uploadTargetTopic = topic.name;
          filesPickerInput.click();
        });
      }
      return;
    }

    episodesListContainer.innerHTML = topic.episodes.map(ep => {
      const prog = getEpisodeProgress(ep.id);
      const isPlayingThis = state.currentEpisode && state.currentEpisode.id === ep.id;
      const isOffline = state.offlineEpisodeIds.has(ep.id);
      const dlInfo = state.downloadingEpisodes.get(ep.id);
      const pct = prog.completed
        ? 100
        : (prog.duration > 0 ? Math.min(99, Math.round((prog.currentTime / prog.duration) * 100)) : 0);

      let statusHtml = '<span>Sin empezar</span>';
      if (prog.completed) {
        statusHtml = `<span class="ep-completed-badge">✓ Completado</span>`;
        if (prog.duration > 0) {
          statusHtml += `<span>· ${formatTime(prog.duration)}</span>`;
        }
      } else if (prog.currentTime > 3) {
        const durStr = prog.duration > 0 ? ` / ${formatTime(prog.duration)}` : '';
        statusHtml = `<span class="ep-resume-badge">En ${formatTime(prog.currentTime)}${durStr} (${pct}%)</span>`;
      } else if (prog.duration > 0) {
        statusHtml = `<span>Duración: ${formatTime(prog.duration)}</span>`;
      }

      let downloadBadgeHtml = '';
      if (isOffline) {
        downloadBadgeHtml = '<span class="offline-chip">En memoria</span>';
      } else if (dlInfo) {
        const dlText = dlInfo.status === 'downloading' ? `⏳ ${dlInfo.pct}%` : '⏳ En cola';
        downloadBadgeHtml = `<span class="downloading-chip">${dlText}</span>`;
      }

      const sizeStr = formatBytes(ep.size);

      return `
        <div class="episode-item ${isPlayingThis ? 'playing' : ''} ${prog.completed ? 'completed' : ''}" data-ep-id="${ep.id}">
          <div class="episode-num-box">
            ${isPlayingThis
              ? `<span class="eq-bars ${state.isPlaying ? 'is-active' : ''}"><i></i><i></i><i></i><i></i></span>`
              : (prog.completed ? '✓' : ep.episodeNumber)}
          </div>

          <div class="episode-main">
            <div class="episode-title-row">
              <span class="episode-title">${ep.title}</span>
              <span class="ep-download-status-slot">${downloadBadgeHtml}</span>
            </div>
            <div class="episode-meta-row">
              ${statusHtml}
              ${sizeStr ? `<span>· ${sizeStr}</span>` : ''}
            </div>
            <div class="episode-bar-track">
              <div class="episode-bar-fill" style="width: ${pct}%"></div>
            </div>
          </div>

          <div class="episode-actions">
            ${prog.currentTime > 3 ? `
              <button class="ep-icon-btn" data-action="restart" data-ep-id="${ep.id}" title="Reiniciar desde el minuto 00:00">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                  <path d="M3 3v5h5"/>
                </svg>
              </button>
            ` : ''}

            <button class="ep-icon-btn ${prog.completed ? 'is-completed' : ''}" data-action="toggle-complete" data-ep-id="${ep.id}" title="Marcar o desmarcar como completado">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2">
                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                <polyline points="22 4 12 14.01 9 11.01"/>
              </svg>
            </button>

            ${!isOffline ? `
              <button class="ep-icon-btn" data-action="save-offline" data-ep-id="${ep.id}" title="Guardar en la memoria del celular">
                <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="7 10 12 15 17 10"/>
                  <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
              </button>
            ` : ''}

            <button class="ep-icon-btn ep-delete-btn" data-action="delete-episode" data-ep-id="${ep.id}" title="Eliminar este audio">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      `;
    }).join('');

    episodesListContainer.querySelectorAll('.episode-item').forEach(row => {
      row.addEventListener('click', async e => {
        const actionBtn = e.target.closest('[data-action]');
        const epId = row.getAttribute('data-ep-id');
        const ep = topic.episodes.find(x => x.id === epId);
        if (!ep) return;

        if (actionBtn) {
          e.stopPropagation();
          const action = actionBtn.getAttribute('data-action');
          if (action === 'toggle-complete') {
            const p = getEpisodeProgress(ep.id);
            updateEpisodeProgress(ep.id, { completed: !p.completed });
            renderAll();
            updateFullPlayerCompleteButton();
            showToast(!p.completed ? 'Marcado como completado ✓' : 'Marcado como pendiente');
          } else if (action === 'restart') {
            updateEpisodeProgress(ep.id, { currentTime: 0, completed: false });
            playEpisode(ep, topic, { openFull: true, forceRestart: true });
          } else if (action === 'save-offline') {
            downloadEpisodeForOffline(ep);
          } else if (action === 'delete-episode') {
            if (window.confirm(`¿Deseas eliminar "${ep.title}" de esta carpeta?`)) {
              await deleteOfflineEpisodeById(ep.id);
              topic.episodes = topic.episodes.filter(e => e.id !== ep.id);
              topic.episodeCount = topic.episodes.length;
              topic.episodes.forEach((e, idx) => { e.episodeNumber = idx + 1; });
              renderTopicDetail(topic);
              updateOfflineCountUI();
              showToast('Audio eliminado');
            }
          }
          return;
        }

        playEpisode(ep, topic, { openFull: true });
      });
    });
  }

  // ============================================================
  // MINI-PLAYER & FULL-SCREEN PLAYER UI UPDATES
  // ============================================================
  function updatePlayerUI() {
    if (!state.currentEpisode) {
      miniPlayer.classList.add('hidden');
      return;
    }

    miniPlayer.classList.remove('hidden');
    miniPlayer.classList.toggle('is-playing', Boolean(state.isPlaying));
    const topicName = state.currentTopic ? state.currentTopic.name : state.currentEpisode.topicName;
    const coverUrl = state.currentTopic ? state.currentTopic.coverUrl : null;
    const artHtml = renderTopicArtworkSVG(topicName, coverUrl);

    miniCover.innerHTML = `${artHtml}<span class="mini-cover-eq"><span class="eq-bars ${state.isPlaying ? 'is-active' : ''}"><i></i><i></i><i></i><i></i></span></span>`;
    miniTitle.textContent = state.currentEpisode.title;
    miniTopic.textContent = topicName;

    fpHeaderTopic.textContent = topicName;
    fpArtwork.innerHTML = artHtml;
    fpTitle.textContent = state.currentEpisode.title;
    fpSubtitle.textContent = `📁 ${topicName} · Episodio ${state.currentEpisode.episodeNumber}`;

    if (state.isPlaying) {
      miniPlayIcon.classList.add('hidden');
      miniPauseIcon.classList.remove('hidden');
      fpPlayIcon.classList.add('hidden');
      fpPauseIcon.classList.remove('hidden');
      fpArtworkContainer.classList.add('is-playing');
    } else {
      miniPlayIcon.classList.remove('hidden');
      miniPauseIcon.classList.add('hidden');
      fpPlayIcon.classList.remove('hidden');
      fpPauseIcon.classList.add('hidden');
      fpArtworkContainer.classList.remove('is-playing');
    }

    updateBackdropMesh(topicName);

    const canvas = document.getElementById('fpVisualizerCanvas');
    const fpArt = document.getElementById('fpArtwork');
    const pill = document.getElementById('fpModeSwitcherPill');
    if (state.appearance.animatedArt) {
      if (canvas) canvas.classList.remove('hidden');
      if (fpArt) fpArt.classList.add('hidden');
      if (pill) pill.classList.remove('hidden');
      if (!fullPlayerOverlay.classList.contains('hidden')) {
        startVisualizerLoop();
      }
    } else {
      if (canvas) canvas.classList.add('hidden');
      if (fpArt) fpArt.classList.remove('hidden');
      if (pill) pill.classList.add('hidden');
      stopVisualizerLoop();
    }

    fpSpeedLabel.textContent = `${state.playbackRate}x`;
    updateFullPlayerCompleteButton();
    updateFullPlayerOfflineButton();
    renderBookmarksInPlayer();
  }

  function updateTimeDisplays(currentTime, duration) {
    const safeDur = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const safeCur = Math.min(safeDur || Infinity, Math.max(0, currentTime || 0));
    const pct = safeDur > 0 ? Math.min(100, (safeCur / safeDur) * 100) : 0;

    miniProgressFill.style.width = `${pct}%`;
    miniTime.textContent = safeDur > 0
      ? `${formatTime(safeCur)} / ${formatTime(safeDur)}`
      : formatTime(safeCur);

    fpCurrentTime.textContent = formatTime(safeCur);
    fpRemainingTime.textContent = safeDur > 0
      ? `-${formatTime(Math.max(0, safeDur - safeCur))}`
      : '00:00';
    fpPercentLabel.textContent = `${Math.round(pct)}%`;

    if (!state.isScrubbing) {
      fpSeekSlider.value = safeDur > 0 ? Math.round((safeCur / safeDur) * 1000) : 0;
      fpRangeProgress.style.width = `${pct}%`;
    }
  }

  function updateFullPlayerCompleteButton() {
    if (!state.currentEpisode) return;
    const prog = getEpisodeProgress(state.currentEpisode.id);
    if (prog.completed) {
      fpToggleCompleteBtn.classList.add('active');
      fpCompleteCaption.textContent = '✓ Completado';
    } else {
      fpToggleCompleteBtn.classList.remove('active');
      fpCompleteCaption.textContent = 'Completado';
    }
  }

  function updateFullPlayerOfflineButton() {
    if (!state.currentEpisode) return;
    const isOffline = state.offlineEpisodeIds.has(state.currentEpisode.id);
    const dlInfo = state.downloadingEpisodes.get(state.currentEpisode.id);
    if (isOffline) {
      fpSaveOfflineBtn.classList.add('active');
      fpOfflineCaption.textContent = '✓ En celular';
    } else if (dlInfo) {
      fpSaveOfflineBtn.classList.remove('active');
      fpOfflineCaption.textContent = dlInfo.status === 'downloading' ? `⏳ ${dlInfo.pct}%` : '⏳ En cola';
    } else {
      fpSaveOfflineBtn.classList.remove('active');
      fpOfflineCaption.textContent = 'Guardar';
    }
  }

  function renderBookmarksInPlayer() {
    if (!state.currentEpisode) return;
    const prog = getEpisodeProgress(state.currentEpisode.id);
    const bookmarks = prog.bookmarks || [];

    if (bookmarks.length === 0) {
      fpBookmarksContainer.classList.add('hidden');
      return;
    }

    fpBookmarksContainer.classList.remove('hidden');
    fpBookmarksContainer.innerHTML = `
      <div class="fp-bookmarks-title">📌 Marcadores guardados en este episodio:</div>
      <div class="bookmark-chips">
        ${bookmarks.map((bm, idx) => `
          <span class="bookmark-chip" data-bm-time="${bm.time}">
            <span>▶ ${formatTime(bm.time)}</span>
            <span class="bookmark-del" data-bm-del="${idx}" title="Eliminar marcador">&times;</span>
          </span>
        `).join('')}
      </div>
    `;

    fpBookmarksContainer.querySelectorAll('.bookmark-chip').forEach(chip => {
      chip.addEventListener('click', e => {
        const delBtn = e.target.closest('[data-bm-del]');
        if (delBtn) {
          e.stopPropagation();
          const idx = parseInt(delBtn.getAttribute('data-bm-del'), 10);
          const nextBms = bookmarks.filter((_, i) => i !== idx);
          updateEpisodeProgress(state.currentEpisode.id, { bookmarks: nextBms });
          renderBookmarksInPlayer();
          return;
        }
        const targetTime = parseFloat(chip.getAttribute('data-bm-time'));
        if (Number.isFinite(targetTime)) {
          audio.currentTime = targetTime;
          if (audio.paused) audio.play();
        }
      });
    });
  }

  // ============================================================
  // VISUALIZER ENGINE (AURORA, SEDA, HALO, NEÓN) + AMBIENT BACKDROP + VOICE-REACTIVE
  // ============================================================
  const VISUALIZER_MODES = [
    { id: 'orb', label: '✦ Aurora' },
    { id: 'studio', label: '〰 Seda' },
    { id: 'halo', label: '◎ Halo' },
    { id: 'neon', label: '⚡ Neón' }
  ];

  const VIZ_SIZE = 560; // logical drawing units; the backing store is scaled for sharp HiDPI screens
  const VIZ_BANDS = 36;

  const vizState = {
    modeIndex: (parseInt(localStorage.getItem('auracast_viz_mode') || '0', 10) || 0) % VISUALIZER_MODES.length,
    rafId: null,
    phase: 0,
    energy: 0.15,
    levelPeak: 0.2,
    bandPeak: 0.3,
    bars: new Float32Array(72),
    bands: new Float32Array(VIZ_BANDS),
    rawBands: new Float32Array(VIZ_BANDS),
    particles: Array.from({ length: 34 }, (_, i) => ({
      angle: (i / 34) * Math.PI * 2,
      radius: 55 + Math.random() * 155,
      speed: 0.18 + Math.random() * 0.45,
      drift: (Math.random() - 0.5) * 0.008,
      size: 1.2 + Math.random() * 2.4,
      alpha: 0.25 + Math.random() * 0.65
    }))
  };

  // Web Audio analyser: created lazily, only when the full player is visible while playing.
  // Once the <audio> element is routed through it, the context must stay running or the sound stops,
  // so it is resumed on every play / visibility change.
  const audioViz = { ctx: null, analyser: null, freqData: null, failed: false };

  function ensureAudioAnalyser() {
    if (audioViz.analyser || audioViz.failed) return audioViz.analyser;
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      audioViz.failed = true;
      return null;
    }
    try {
      const ctx = new AC();
      const source = ctx.createMediaElementSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.72;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioViz.ctx = ctx;
      audioViz.analyser = analyser;
      audioViz.freqData = new Uint8Array(analyser.frequencyBinCount);
      resumeAudioAnalyser();
    } catch (e) {
      audioViz.failed = true;
      return null;
    }
    return audioViz.analyser;
  }

  function resumeAudioAnalyser() {
    if (audioViz.ctx && audioViz.ctx.state !== 'running') {
      audioViz.ctx.resume().catch(() => {});
    }
  }

  // Returns normalized voice level 0..1 from the real audio, or -1 when unavailable.
  function sampleAudioLevels() {
    const analyser = audioViz.analyser;
    if (!analyser || state.appearance.vizReactive === false || !state.isPlaying) return -1;
    if (!audioViz.ctx || audioViz.ctx.state !== 'running') return -1;

    const data = audioViz.freqData;
    analyser.getByteFrequencyData(data);
    const binHz = audioViz.ctx.sampleRate / analyser.fftSize;
    const lo = Math.max(1, Math.floor(80 / binHz));
    const hi = Math.min(data.length - 1, Math.ceil(5000 / binHz));

    let sum = 0;
    for (let i = lo; i <= hi; i++) sum += data[i];
    const level = sum / ((hi - lo + 1) * 255);
    // Adaptive gain: quiet and loud recordings both use the full animation range
    vizState.levelPeak = Math.max(level, vizState.levelPeak * 0.997, 0.06);

    const raw = vizState.rawBands;
    let frameMax = 0;
    for (let b = 0; b < VIZ_BANDS; b++) {
      const f0 = Math.floor(lo * Math.pow(hi / lo, b / VIZ_BANDS));
      const f1 = Math.max(f0, Math.floor(lo * Math.pow(hi / lo, (b + 1) / VIZ_BANDS)));
      let s = 0;
      for (let i = f0; i <= f1; i++) s += data[i];
      raw[b] = s / (f1 - f0 + 1) / 255;
      if (raw[b] > frameMax) frameMax = raw[b];
    }
    // Shared peak keeps the real spectral shape (strong lows, softer highs); the curve adds contrast
    vizState.bandPeak = Math.max(frameMax, vizState.bandPeak * 0.996, 0.12);
    for (let b = 0; b < VIZ_BANDS; b++) {
      const v = Math.pow(Math.min(1, raw[b] / vizState.bandPeak), 1.6);
      vizState.bands[b] += (v - vizState.bands[b]) * (v > vizState.bands[b] ? 0.55 : 0.16);
    }
    return Math.min(1, level / vizState.levelPeak);
  }

  function updateVisualizerEnergy() {
    const rate = state.playbackRate || 1;
    const live = sampleAudioLevels();
    if (live >= 0) {
      const target = 0.1 + 0.9 * live;
      vizState.energy += (target - vizState.energy) * (target > vizState.energy ? 0.35 : 0.09);
    } else {
      const target = state.isPlaying ? 1.0 : 0.14;
      vizState.energy += (target - vizState.energy) * 0.07;
      const t = vizState.phase;
      for (let b = 0; b < VIZ_BANDS; b++) {
        const v = state.isPlaying
          ? 0.3 + 0.5 * Math.abs(Math.sin(b * 0.5 + t * 2.2) * Math.cos(b * 0.23 - t * 1.7))
          : 0.05;
        vizState.bands[b] += (v - vizState.bands[b]) * 0.2;
      }
    }
    vizState.phase += state.isPlaying ? (0.014 + 0.026 * vizState.energy) * rate : 0.008;
  }

  function getEpisodeDisplayTitle(episode) {
    if (!episode) return 'Selecciona un episodio';
    const raw = String(episode.title || '').trim();
    const cleaned = raw.replace(/^\s*(?:ep(?:isodio)?\.?\s*)?\d+\s*[-–—.:_)]*\s*/i, '').trim();
    return cleaned || raw;
  }

  function wrapCanvasText(ctx, text, maxWidth, maxLines) {
    const words = String(text || '').split(/\s+/).filter(Boolean);
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      lines.length = maxLines;
      let last = lines[maxLines - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
        last = last.slice(0, -1).trimEnd();
      }
      lines[maxLines - 1] = `${last}…`;
    }
    return lines;
  }

  function drawTextLines(ctx, lines, x, firstBaselineY, lineHeight) {
    lines.forEach((l, i) => ctx.fillText(l, x, firstBaselineY + i * lineHeight));
  }

  function fitTextToWidth(ctx, text, maxWidth) {
    let s = String(text || '');
    if (ctx.measureText(s).width <= maxWidth) return s;
    while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
    return `${s.trimEnd()}…`;
  }

  function updateVisualizerModeBadge() {
    const mode = VISUALIZER_MODES[vizState.modeIndex] || VISUALIZER_MODES[0];
    const nameEl = document.getElementById('fpModeNameLabel');
    const dotsEl = document.getElementById('fpModeDots');
    if (nameEl) nameEl.textContent = mode.label;
    if (dotsEl) {
      Array.from(dotsEl.children).forEach((dot, idx) => {
        dot.classList.toggle('active', idx === vizState.modeIndex);
      });
    }
    document.querySelectorAll('#settingsVizPills .viz-pill').forEach(pill => {
      const pIdx = parseInt(pill.getAttribute('data-viz-idx'), 10);
      pill.classList.toggle('active', pIdx === vizState.modeIndex);
    });
  }

  function setVisualizerModeIndex(idx) {
    vizState.modeIndex = ((idx % VISUALIZER_MODES.length) + VISUALIZER_MODES.length) % VISUALIZER_MODES.length;
    try {
      localStorage.setItem('auracast_viz_mode', String(vizState.modeIndex));
    } catch (e) {}
    updateVisualizerModeBadge();
    drawVisualizerFrame();
  }

  function cycleVisualizerMode() {
    if (!state.appearance.animatedArt) {
      applyAppearance({ animatedArt: true });
    } else {
      setVisualizerModeIndex(vizState.modeIndex + 1);
    }
    showToast(`Diseño: ${VISUALIZER_MODES[vizState.modeIndex].label}`);
  }

  function startVisualizerLoop() {
    updateVisualizerModeBadge();
    if (state.appearance.vizReactive !== false && state.isPlaying) {
      ensureAudioAnalyser();
      resumeAudioAnalyser();
    }
    if (vizState.rafId) return;
    const tick = () => {
      if (fullPlayerOverlay.classList.contains('hidden') || document.visibilityState === 'hidden') {
        vizState.rafId = null;
        return;
      }
      drawVisualizerFrame();
      vizState.rafId = requestAnimationFrame(tick);
    };
    vizState.rafId = requestAnimationFrame(tick);
  }

  function stopVisualizerLoop() {
    if (vizState.rafId) {
      cancelAnimationFrame(vizState.rafId);
      vizState.rafId = null;
    }
  }

  function prepareVisualizerCanvas(canvas) {
    const cssW = canvas.clientWidth || 340;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const target = Math.round(Math.max(VIZ_SIZE, cssW * dpr));
    if (canvas.width !== target) {
      canvas.width = target;
      canvas.height = target;
    }
    const ctx = canvas.getContext('2d');
    const scale = target / VIZ_SIZE;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    return ctx;
  }

  function drawVisualizerFrame() {
    const canvas = document.getElementById('fpVisualizerCanvas');
    if (!canvas) return;
    const ctx = prepareVisualizerCanvas(canvas);
    const W = VIZ_SIZE;
    const H = VIZ_SIZE;
    const cx = W / 2;
    const cy = H / 2 - 6;

    const topicName = state.currentTopic
      ? state.currentTopic.name
      : (state.currentEpisode ? state.currentEpisode.topicName : 'AuraCast');
    const cleanTopic = (topicName || 'Podcast').replace(/^\d+[\s._-]*/, '').trim() || topicName;
    const [c1, c2, c3] = getTopicPalette(topicName);

    const dur = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const cur = audio.currentTime || 0;
    const info = {
      title: getEpisodeDisplayTitle(state.currentEpisode),
      topic: cleanTopic.toUpperCase(),
      epNum: state.currentEpisode ? String(state.currentEpisode.episodeNumber || 1).padStart(2, '0') : '01',
      progressRatio: dur > 0 ? Math.min(1, Math.max(0, cur / dur)) : 0
    };

    updateVisualizerEnergy();
    ctx.clearRect(0, 0, W, H);

    if (state.appearance.vizAmbient !== false) {
      drawAmbientBackdrop(ctx, W, H, c1, c2);
    } else {
      const bgGrad = ctx.createRadialGradient(
        cx + Math.sin(vizState.phase * 0.5) * 40,
        cy - 30 + Math.cos(vizState.phase * 0.4) * 30,
        15,
        cx,
        cy,
        W * 0.78
      );
      bgGrad.addColorStop(0, c1 + '38');
      bgGrad.addColorStop(0.45, c2 + '26');
      bgGrad.addColorStop(0.8, c3);
      bgGrad.addColorStop(1, '#05060B');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);
    }

    const modeId = (VISUALIZER_MODES[vizState.modeIndex] || VISUALIZER_MODES[0]).id;
    if (modeId === 'orb') {
      drawOrbMode(ctx, W, H, cx, cy, c1, c2, c3, info);
    } else if (modeId === 'studio') {
      drawStudioMode(ctx, W, H, cx, cy, c1, c2, c3, info);
    } else if (modeId === 'halo') {
      drawHaloMode(ctx, W, H, cx, cy, c1, c2, c3, info);
    } else {
      drawNeonMode(ctx, W, H, cx, cy, c1, c2, c3, info);
    }
  }

  // AMBIENT: slow liquid colour blobs (Apple Music style) behind every mode
  function drawAmbientBackdrop(ctx, W, H, c1, c2) {
    const ts = performance.now() / 1000;
    const e = vizState.energy;
    ctx.fillStyle = '#07060E';
    ctx.fillRect(0, 0, W, H);

    const blobs = [
      [c1, 0.22, 0.2, 0.0, 0.62],
      [c2, 0.8, 0.3, 1.7, 0.7],
      [c1, 0.3, 0.82, 3.1, 0.5],
      [c2, 0.85, 0.88, 4.4, 0.55]
    ];
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const [color, bx, by, seed, alpha] of blobs) {
      const x = W * (bx + 0.14 * Math.sin(ts * 0.11 + seed));
      const y = H * (by + 0.1 * Math.cos(ts * 0.09 + seed * 1.3));
      const r = W * (0.5 + 0.04 * e + 0.03 * Math.sin(ts * 0.2 + seed));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color + 'DD');
      g.addColorStop(0.55, color + '44');
      g.addColorStop(1, color + '00');
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();

    const veil = ctx.createRadialGradient(W / 2, H / 2, W * 0.2, W / 2, H / 2, W * 0.75);
    veil.addColorStop(0, 'rgba(5,6,11,0.18)');
    veil.addColorStop(1, 'rgba(5,6,11,0.62)');
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, W, H);
  }

  // MODE 1: AURORA (liquid petals + pearl core that breathe with the voice)
  function drawOrbMode(ctx, W, H, cx, cy, c1, c2, c3, info) {
    const t = vizState.phase;
    const energy = vizState.energy;

    ctx.save();
    for (const p of vizState.particles) {
      p.angle += p.drift * (0.4 + 0.6 * energy);
      if (state.isPlaying) {
        p.radius += p.speed * (0.3 + 0.8 * energy);
        if (p.radius > 235) p.radius = 65;
      }
      const px = cx + Math.cos(p.angle + t * 0.12) * p.radius;
      const py = cy + Math.sin(p.angle + t * 0.12) * p.radius;
      const fade = Math.max(0, 1 - Math.abs(p.radius - 150) / 85);
      ctx.globalAlpha = p.alpha * fade * (0.3 + 0.7 * energy);
      ctx.fillStyle = '#FFFFFF';
      ctx.shadowColor = c1;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    const layers = [
      { baseR: 160, amp1: 24, amp2: 14, freq1: 3, freq2: 5, speed: 1.1, color1: c1, color2: c2, alpha: 0.26, lineW: 2 },
      { baseR: 144, amp1: 20, amp2: 12, freq1: 4, freq2: 3, speed: -1.4, color1: '#FFFFFF', color2: c1, alpha: 0.34, lineW: 2.2 },
      { baseR: 128, amp1: 16, amp2: 10, freq1: 5, freq2: 2, speed: 1.8, color1: c1, color2: '#FFFFFF', alpha: 0.48, lineW: 2.5 }
    ];

    for (const layer of layers) {
      ctx.save();
      ctx.beginPath();
      const steps = 120;
      for (let i = 0; i <= steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const w1 = Math.sin(a * layer.freq1 + t * layer.speed);
        const w2 = Math.cos(a * layer.freq2 - t * layer.speed * 0.8);
        const r = layer.baseR + (w1 * layer.amp1 + w2 * layer.amp2) * (0.15 + 1.05 * energy);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();

      const grad = ctx.createLinearGradient(cx - 150, cy - 150, cx + 150, cy + 150);
      grad.addColorStop(0, layer.color1 + '66');
      grad.addColorStop(1, layer.color2 + '22');
      ctx.fillStyle = grad;
      ctx.globalAlpha = layer.alpha * (0.5 + 0.5 * energy);
      ctx.fill();

      ctx.globalAlpha = Math.min(1, layer.alpha * 1.9 * (0.4 + 0.6 * energy));
      ctx.strokeStyle = layer.color1;
      ctx.lineWidth = layer.lineW;
      ctx.shadowColor = layer.color1;
      ctx.shadowBlur = 16 * energy;
      ctx.stroke();
      ctx.restore();
    }

    // Outer progress ring with pearl tip
    const ringRadius = 214;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.stroke();

    if (info.progressRatio > 0) {
      const startAng = -Math.PI / 2;
      const endAng = startAng + info.progressRatio * Math.PI * 2;
      ctx.save();
      ctx.strokeStyle = c1;
      ctx.lineWidth = 3.5;
      ctx.lineCap = 'round';
      ctx.shadowColor = c1;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, startAng, endAng);
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(endAng) * ringRadius, cy + Math.sin(endAng) * ringRadius, 4.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Frosted pearl core holding the episode title
    const coreR = 104 + 5 * energy;
    const coreGrad = ctx.createRadialGradient(cx - 26, cy - 26, 8, cx, cy, coreR);
    coreGrad.addColorStop(0, c1 + 'CC');
    coreGrad.addColorStop(0.55, c2 + 'AA');
    coreGrad.addColorStop(1, '#090B14');
    ctx.save();
    ctx.shadowColor = c1;
    ctx.shadowBlur = 34 * energy;
    ctx.fillStyle = coreGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = 'rgba(255,255,255,0.34)';
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '700 17px Inter, sans-serif';
    const lines = wrapCanvasText(ctx, info.title, 162, 3);
    const lh = 21;
    const block = 14 + 10 + lines.length * lh;
    const top = cy - block / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '700 10.5px Inter, sans-serif';
    ctx.fillText(fitTextToWidth(ctx, `${info.topic} · EP ${info.epNum}`, 160), cx, top + 10);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 17px Inter, sans-serif';
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = 6;
    drawTextLines(ctx, lines, cx, top + 24 + 15, lh);
    ctx.restore();
  }

  // MODE 2: SEDA (silk ribbons + pearl equalizer driven by the voice spectrum)
  function drawStudioMode(ctx, W, H, cx, cy, c1, c2, c3, info) {
    const t = vizState.phase;
    const energy = vizState.energy;

    // Header: topic label + large episode title
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.font = '700 12px Inter, sans-serif';
    ctx.fillText(fitTextToWidth(ctx, `${info.topic} · EP ${info.epNum} · ${Math.round(info.progressRatio * 100)}%`, 440), cx, 58);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '800 30px Inter, sans-serif';
    ctx.shadowColor = c1;
    ctx.shadowBlur = 16 * energy;
    drawTextLines(ctx, wrapCanvasText(ctx, info.title, 470, 2), cx, 104, 36);
    ctx.restore();

    const waveCenterY = 278;
    const ribbons = [
      { amp: 52, freq: 0.012, speed: 1.5, color: c1, alpha: 0.85, fillAlpha: 0.18, width: 3 },
      { amp: 38, freq: 0.018, speed: -1.2, color: '#FFFFFF', alpha: 0.55, fillAlpha: 0.08, width: 2 },
      { amp: 32, freq: 0.023, speed: 2.1, color: c2, alpha: 0.7, fillAlpha: 0.14, width: 2.4 },
      { amp: 22, freq: 0.031, speed: -1.9, color: c1, alpha: 0.4, fillAlpha: 0.05, width: 1.5 }
    ];

    for (const r of ribbons) {
      ctx.save();
      ctx.beginPath();
      for (let x = 20; x <= W - 20; x += 5) {
        const normX = (x - 20) / (W - 40);
        const env = Math.pow(Math.sin(normX * Math.PI), 1.4);
        const yOff =
          (Math.sin(x * r.freq + t * r.speed) * 0.65 +
            Math.cos(x * r.freq * 0.6 - t * r.speed * 0.7) * 0.35) *
          r.amp *
          env *
          (0.12 + 0.95 * energy);
        const y = waveCenterY + yOff;
        if (x === 20) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }

      ctx.strokeStyle = r.color;
      ctx.globalAlpha = r.alpha;
      ctx.lineWidth = r.width;
      ctx.shadowColor = r.color;
      ctx.shadowBlur = 14 * energy;
      ctx.stroke();

      ctx.lineTo(W - 20, waveCenterY + 75);
      ctx.lineTo(20, waveCenterY + 75);
      ctx.closePath();
      const fillGrad = ctx.createLinearGradient(0, waveCenterY - r.amp, 0, waveCenterY + 75);
      fillGrad.addColorStop(0, r.color);
      fillGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = fillGrad;
      ctx.globalAlpha = r.fillAlpha * energy;
      ctx.fill();
      ctx.restore();
    }

    // Symmetrical pill equalizer: low voice frequencies in the centre, highs on the edges
    const numBands = 32;
    const totalW = W - 96;
    const step = totalW / numBands;
    const barW = 5;
    const eqCenterY = 420;

    ctx.save();
    for (let i = 0; i < numBands; i++) {
      const centerDist = Math.sin((i / (numBands - 1)) * Math.PI);
      const bandIdx = Math.min(VIZ_BANDS - 1, Math.floor((Math.abs(i - (numBands - 1) / 2) / (numBands / 2)) * VIZ_BANDS * 0.8));
      const targetH = 5 + vizState.bands[bandIdx] * 74 * (0.35 + 0.65 * centerDist);
      vizState.bars[i] += (targetH - vizState.bars[i]) * 0.3;
      const h = vizState.bars[i];
      const bx = 48 + i * step + (step - barW) / 2;

      const grad = ctx.createLinearGradient(bx, eqCenterY - h / 2, bx, eqCenterY + h / 2);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.5, '#FFFFFF');
      grad.addColorStop(1, c2);

      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.45 + 0.55 * centerDist;
      ctx.beginPath();
      ctx.roundRect(bx, eqCenterY - h / 2, barW, h, barW / 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // MODE 3: HALO (breathing rings + radial needles that follow the voice spectrum)
  function drawHaloMode(ctx, W, H, cx, cy, c1, c2, c3, info) {
    const t = vizState.phase;
    const energy = vizState.energy;

    for (let rIdx = 0; rIdx < 4; rIdx++) {
      const wave = ((t * 0.45 + rIdx * 0.25) % 1);
      const rad = 92 + wave * 140;
      const alpha = (1 - wave) * 0.36 * (0.3 + 0.7 * energy);
      ctx.save();
      ctx.strokeStyle = rIdx % 2 === 0 ? c1 : '#FFFFFF';
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const numNeedles = 72;
    const innerR = 118;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = 0; i < numNeedles; i++) {
      const ang = (i / numNeedles) * Math.PI * 2 - Math.PI / 2;
      const mirrored = i < numNeedles / 2 ? i : numNeedles - 1 - i;
      const bandIdx = Math.min(VIZ_BANDS - 1, Math.floor((mirrored / (numNeedles / 2)) * VIZ_BANDS * 0.85));
      const len = 7 + vizState.bands[bandIdx] * 50 * (0.4 + 0.6 * energy);

      vizState.bars[i] += (len - vizState.bars[i]) * 0.3;
      const curLen = vizState.bars[i];

      const isPlayed = (i / numNeedles) <= info.progressRatio;
      ctx.strokeStyle = isPlayed ? c1 : 'rgba(255,255,255,0.42)';
      ctx.lineWidth = isPlayed ? 2.6 : 1.8;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * innerR, cy + Math.sin(ang) * innerR);
      ctx.lineTo(cx + Math.cos(ang) * (innerR + curLen), cy + Math.sin(ang) * (innerR + curLen));
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.fillStyle = 'rgba(12, 14, 24, 0.86)';
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, 108, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.font = '700 16px Inter, sans-serif';
    const lines = wrapCanvasText(ctx, info.title, 170, 3);
    const lh = 20;
    const block = 14 + 10 + lines.length * lh + 18;
    const top = cy - block / 2;
    ctx.fillStyle = c1;
    ctx.font = '700 12px Inter, sans-serif';
    ctx.fillText(`EP ${info.epNum} · ${Math.round(info.progressRatio * 100)}%`, cx, top + 11);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 16px Inter, sans-serif';
    drawTextLines(ctx, lines, cx, top + 24 + 14, lh);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '600 10.5px Inter, sans-serif';
    ctx.fillText(fitTextToWidth(ctx, info.topic, 160), cx, top + 24 + lines.length * lh + 16);
    ctx.restore();
  }

  // MODE 4: NEÓN (mirrored glowing spectrum over a synthwave grid)
  function drawNeonMode(ctx, W, H, cx, cy, c1, c2, c3, info) {
    const t = vizState.phase;
    const energy = vizState.energy;
    const neonA = '#22D3EE';
    const neonB = c1;
    const horizon = Math.round(H * 0.64);

    // Sky glow toward the horizon
    const sky = ctx.createLinearGradient(0, horizon - 220, 0, horizon);
    sky.addColorStop(0, 'rgba(0,0,0,0)');
    sky.addColorStop(1, neonB + '55');
    ctx.fillStyle = sky;
    ctx.fillRect(0, horizon - 220, W, 220);

    // Floor + perspective grid
    ctx.fillStyle = 'rgba(6,4,14,0.78)';
    ctx.fillRect(0, horizon, W, H - horizon);
    ctx.save();
    ctx.strokeStyle = neonB;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.45;
    for (let i = -10; i <= 10; i++) {
      ctx.beginPath();
      ctx.moveTo(cx + i * 14, horizon);
      ctx.lineTo(cx + i * 90, H);
      ctx.stroke();
    }
    const scroll = (t * 0.55) % 1;
    for (let j = 0; j < 7; j++) {
      const p = (j + scroll) / 7;
      const y = horizon + (H - horizon) * p * p;
      ctx.globalAlpha = 0.15 + 0.5 * p;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();

    // Mirrored spectrum bars (voice lows in the centre) with floor reflection
    const n = 28;
    const areaW = W * 0.84;
    const bw = areaW / n;
    const x0 = (W - areaW) / 2;
    ctx.save();
    for (let i = 0; i < n; i++) {
      const k = Math.abs(i - (n - 1) / 2) / (n / 2);
      const bandIdx = Math.min(VIZ_BANDS - 1, Math.floor(k * VIZ_BANDS * 0.8));
      const targetH = 4 + vizState.bands[bandIdx] * H * 0.3 * (1 - k * 0.45) * (0.35 + 0.65 * energy);
      vizState.bars[i] += (targetH - vizState.bars[i]) * 0.32;
      const h = vizState.bars[i];
      const bx = x0 + i * bw + 2;
      const g = ctx.createLinearGradient(0, horizon - h, 0, horizon);
      g.addColorStop(0, neonA);
      g.addColorStop(1, neonB);
      ctx.fillStyle = g;
      ctx.globalAlpha = 1;
      ctx.shadowColor = neonB;
      ctx.shadowBlur = 14;
      ctx.fillRect(bx, horizon - h, bw - 4, h);
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.2;
      ctx.fillRect(bx, horizon + 2, bw - 4, h * 0.45);
    }
    ctx.restore();

    // Horizon progress line
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(x0, horizon - 1, areaW, 2);
    ctx.fillStyle = neonA;
    ctx.shadowColor = neonA;
    ctx.shadowBlur = 10;
    ctx.fillRect(x0, horizon - 1, areaW * info.progressRatio, 2);
    ctx.restore();

    // Title with neon glow
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = neonA;
    ctx.font = '700 12px Inter, sans-serif';
    ctx.shadowColor = neonA;
    ctx.shadowBlur = 8;
    ctx.fillText(fitTextToWidth(ctx, `${info.topic} · EP ${info.epNum}`, 440), cx, 58);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '800 28px Inter, sans-serif';
    ctx.shadowColor = neonB;
    ctx.shadowBlur = 10 + 12 * energy;
    drawTextLines(ctx, wrapCanvasText(ctx, info.title, 470, 2), cx, 100, 34);
    ctx.restore();
  }

  function openFullPlayer() {
    if (!state.currentEpisode) return;
    fullPlayerOverlay.classList.remove('hidden');
    fullPlayerOverlay.setAttribute('aria-hidden', 'false');
    updatePlayerUI();
    startVisualizerLoop();
  }

  function closeFullPlayer() {
    fullPlayerOverlay.classList.add('hidden');
    fullPlayerOverlay.setAttribute('aria-hidden', 'true');
    stopVisualizerLoop();
  }

  // ============================================================
  // MODALS & INTERACTION HANDLERS
  // ============================================================
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  }

  function closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  }

  async function loadServerLocalIPsForModal() {
    const listEl = document.getElementById('localUrlsList');
    try {
      const res = await fetch(`/api/info?_t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const info = await res.json();
        if (info.localIPs && info.localIPs.length > 0) {
          listEl.innerHTML = info.localIPs.map(ip => `
            <div class="url-pill">
              <span>${ip.url}</span>
              <button class="copy-url-btn" data-copy-url="${ip.url}">Copiar</button>
            </div>
          `).join('');
          listEl.querySelectorAll('[data-copy-url]').forEach(btn => {
            btn.addEventListener('click', () => {
              const url = btn.getAttribute('data-copy-url');
              navigator.clipboard?.writeText(url);
              showToast('Dirección copiada al portapapeles');
            });
          });
          return;
        }
      }
    } catch (e) {}

    const currentOrigin = (location.protocol.startsWith('http') && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1')
      ? location.origin
      : 'http://192.168.101.7:3080';

    listEl.innerHTML = `
      <div class="url-pill">
        <span>${currentOrigin}</span>
        <button class="copy-url-btn" data-copy-url="${currentOrigin}">Copiar</button>
      </div>
      <p class="guide-subtext" style="margin-top:6px;">Si no abre, ejecuta <strong>INICIAR_REPRODUCTOR.bat</strong> en tu PC para ver si cambió tu IP de Wi-Fi.</p>
    `;
    listEl.querySelectorAll('[data-copy-url]').forEach(btn => {
      btn.addEventListener('click', () => {
        const url = btn.getAttribute('data-copy-url');
        navigator.clipboard?.writeText(url);
        showToast('Dirección copiada al portapapeles');
      });
    });
  }

  function bindEvents() {
    // Navigation
    document.getElementById('brandHomeBtn').addEventListener('click', closeTopicView);
    backToTopicsBtn.addEventListener('click', closeTopicView);

    const toggleFullscreenBtn = document.getElementById('toggleFullscreenBtn');
    if (toggleFullscreenBtn) {
      toggleFullscreenBtn.addEventListener('click', () => {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        } else {
          document.exitFullscreen?.().catch(() => {});
        }
      });
    }

    document.getElementById('refreshLibraryBtn').addEventListener('click', async () => {
      showToast('🔄 Conectando con PC y buscando nuevas carpetas...');
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then(r => r && r.update()).catch(() => {});
      }
      const ok = await loadLibrary(true);
      if (ok) {
        showToast(`✓ Biblioteca sincronizada (${state.topics.length} temas encontrados)`);
      } else {
        const hostStr = location.host || 'tu red Wi-Fi';
        showToast(`⚠️ No se pudo contactar con la PC en ${hostStr}. Asegúrate de que INICIAR_REPRODUCTOR.bat esté abierto en la PC.`);
      }
    });

    const createTopicBtn = document.getElementById('createTopicBtn');
    if (createTopicBtn) {
      createTopicBtn.addEventListener('click', () => promptCreateNewFolder());
    }

    document.getElementById('openImportModalBtn').addEventListener('click', () => {
      updateOfflineCountUI();
      populateImportTopicSelect();
      openModal('importModal');
    });

    const importNewTopicBtn = document.getElementById('importNewTopicBtn');
    if (importNewTopicBtn) {
      importNewTopicBtn.addEventListener('click', () => {
        const created = promptCreateNewFolder();
        populateImportTopicSelect();
        const selectEl = document.getElementById('importTopicSelect');
        if (created && selectEl) selectEl.value = created;
      });
    }

    const importTopicSelect = document.getElementById('importTopicSelect');
    if (importTopicSelect) {
      importTopicSelect.addEventListener('change', () => {
        if (importTopicSelect.value === '__new__') {
          const created = promptCreateNewFolder();
          populateImportTopicSelect();
          if (created && importTopicSelect) importTopicSelect.value = created;
        }
      });
    }

    document.getElementById('openMobileHelpBtn').addEventListener('click', () => {
      loadServerLocalIPsForModal();
      openModal('mobileHelpModal');
    });

    // Folder & File Inputs
    document.getElementById('triggerFolderInputBtn').addEventListener('click', () => {
      folderPickerInput.click();
    });
    document.getElementById('triggerFilesInputBtn').addEventListener('click', () => {
      filesPickerInput.click();
    });

    folderPickerInput.addEventListener('change', e => {
      handleImportedFiles(e.target.files, true);
      folderPickerInput.value = '';
    });

    filesPickerInput.addEventListener('change', e => {
      handleImportedFiles(e.target.files, false);
      filesPickerInput.value = '';
    });

    clearOfflineStorageBtn.addEventListener('click', async () => {
      if (window.confirm('¿Deseas liberar los audios guardados en la memoria interna del navegador? (Tu progreso de escucha no se borrará)')) {
        await clearAllOfflineEpisodes();
        await loadLibrary();
        showToast('Memoria interna liberada');
      }
    });

    // Top bar scroll elevation & title reveal
    const mainScrollEl = document.getElementById('mainContent');
    const navBarEl = document.getElementById('navBar');
    if (mainScrollEl && navBarEl) {
      mainScrollEl.addEventListener('scroll', () => {
        navBarEl.classList.toggle('scrolled', mainScrollEl.scrollTop > 32);
      }, { passive: true });
    }

    // Theme & Settings
    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const openSettingsBtn = document.getElementById('openSettingsBtn');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', () => openModal('settingsModal'));
    }

    document.querySelectorAll('[data-theme-opt]').forEach(btn => {
      btn.addEventListener('click', () => {
        applyAppearance({ theme: btn.getAttribute('data-theme-opt') });
      });
    });

    document.querySelectorAll('.style-card').forEach(card => {
      card.addEventListener('click', () => {
        const styleVal = card.getAttribute('data-style-opt');
        applyAppearance({ style: styleVal });
        showToast(`Estilo ${styleVal === 'music' ? 'Apple Music' : 'Apple Podcasts'} aplicado`);
      });
    });

    const animatedToggle = document.getElementById('animatedArtToggle');
    if (animatedToggle) {
      animatedToggle.addEventListener('change', e => {
        applyAppearance({ animatedArt: e.target.checked });
        showToast(e.target.checked ? 'Animaciones elegantes activadas' : 'Portada estática activada');
      });
    }

    const reactiveToggle = document.getElementById('vizReactiveToggle');
    if (reactiveToggle) {
      reactiveToggle.addEventListener('change', e => {
        applyAppearance({ vizReactive: e.target.checked });
        if (e.target.checked && !fullPlayerOverlay.classList.contains('hidden')) startVisualizerLoop();
        showToast(e.target.checked ? 'La animación seguirá la voz' : 'Animación libre (sin seguir la voz)');
      });
    }

    const hideCompletedToggle = document.getElementById('hideCompletedToggle');
    if (hideCompletedToggle) {
      hideCompletedToggle.addEventListener('change', e => {
        applyAppearance({ hideCompleted: e.target.checked });
        renderAll();
        showToast(e.target.checked ? 'Temas terminados ocultos' : 'Mostrando todos los temas');
      });
    }

    const ambientToggle = document.getElementById('vizAmbientToggle');
    if (ambientToggle) {
      ambientToggle.addEventListener('change', e => {
        applyAppearance({ vizAmbient: e.target.checked });
        showToast(e.target.checked ? 'Fondo líquido activado' : 'Fondo líquido desactivado');
      });
    }

    document.querySelectorAll('[data-layout-opt]').forEach(btn => {
      btn.addEventListener('click', () => {
        applyAppearance({ libraryLayout: btn.getAttribute('data-layout-opt') });
        renderAll();
        showToast(`Biblioteca: ${btn.textContent.trim()}`);
      });
    });

    document.querySelectorAll('[data-cover-opt]').forEach(btn => {
      btn.addEventListener('click', () => {
        applyAppearance({ coverStyle: btn.getAttribute('data-cover-opt') });
        renderAll();
        updatePlayerUI();
        showToast(`Portadas: ${btn.textContent.trim()}`);
      });
    });

    document.querySelectorAll('#settingsVizPills .viz-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        const idx = parseInt(pill.getAttribute('data-viz-idx'), 10);
        if (!isNaN(idx)) {
          applyAppearance({ animatedArt: true });
          setVisualizerModeIndex(idx);
          showToast(`Diseño: ${VISUALIZER_MODES[vizState.modeIndex].label}`);
        }
      });
    });
    updateVisualizerModeBadge();

    // Search & Filters
    searchInput.addEventListener('input', e => {
      state.searchQuery = e.target.value;
      clearSearchBtn.classList.toggle('hidden', !state.searchQuery);
      renderTopicsGrid();
    });

    clearSearchBtn.addEventListener('click', () => {
      state.searchQuery = '';
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      renderTopicsGrid();
    });

    const filterPills = document.querySelectorAll('.filter-pill');
    const segContainer = document.getElementById('segmentedFilters');
    const filterList = ['all', 'in-progress', 'completed', 'offline'];
    filterPills.forEach(pill => {
      pill.addEventListener('click', () => {
        filterPills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        const filterVal = pill.getAttribute('data-filter');
        state.activeFilter = filterVal;
        const idx = filterList.indexOf(filterVal);
        if (segContainer && idx >= 0) {
          segContainer.style.setProperty('--seg-index', idx);
        }
        renderTopicsGrid();
      });
    });

    // Mark all episodes in topic completed
    markAllTopicCompletedBtn.addEventListener('click', () => {
      const topic = state.topics.find(t => t.id === state.selectedTopicId);
      if (!topic) return;
      const allCompleted = topic.episodes.every(ep => getEpisodeProgress(ep.id).completed);
      for (const ep of topic.episodes) {
        updateEpisodeProgress(ep.id, { completed: !allCompleted });
      }
      renderAll();
      showToast(!allCompleted ? 'Todos los episodios marcados como completados' : 'Episodios marcados como pendientes');
    });

    // Mini Player Controls
    miniExpandTapArea.addEventListener('click', openFullPlayer);
    miniPlayPauseBtn.addEventListener('click', e => {
      e.stopPropagation();
      togglePlayPause();
    });
    miniRewindBtn.addEventListener('click', e => {
      e.stopPropagation();
      skipSeconds(-15);
    });
    miniForwardBtn.addEventListener('click', e => {
      e.stopPropagation();
      skipSeconds(15);
    });

    // Full Player Controls
    closeFullPlayerBtn.addEventListener('click', closeFullPlayer);
    fpArtworkContainer.addEventListener('click', cycleVisualizerMode);
    fpGoToTopicBtn.addEventListener('click', () => {
      closeFullPlayer();
      if (state.currentTopic) {
        openTopicView(state.currentTopic.id);
      }
    });

    fpPlayPauseBtn.addEventListener('click', togglePlayPause);
    fpRewind15Btn.addEventListener('click', () => skipSeconds(-15));
    fpForward15Btn.addEventListener('click', () => skipSeconds(15));
    fpPrevEpBtn.addEventListener('click', () => playAdjacentEpisode(-1));
    fpNextEpBtn.addEventListener('click', () => playAdjacentEpisode(1));

    // Scrubber Slider (Seek)
    fpSeekSlider.addEventListener('input', () => {
      state.isScrubbing = true;
      const dur = audio.duration || 0;
      const ratio = parseFloat(fpSeekSlider.value) / 1000;
      const previewTime = dur * ratio;
      fpRangeProgress.style.width = `${ratio * 100}%`;
      fpCurrentTime.textContent = formatTime(previewTime);
      fpPercentLabel.textContent = `${Math.round(ratio * 100)}%`;
      if (dur > 0) {
        fpRemainingTime.textContent = `-${formatTime(Math.max(0, dur - previewTime))}`;
      }
    });

    fpSeekSlider.addEventListener('change', () => {
      const dur = audio.duration || 0;
      if (dur > 0) {
        const ratio = parseFloat(fpSeekSlider.value) / 1000;
        audio.currentTime = dur * ratio;
        saveCurrentPlaybackPosition();
        updateMediaSessionPosition();
      }
      state.isScrubbing = false;
    });

    // Bookmark current timestamp
    fpSaveBookmarkBtn.addEventListener('click', () => {
      if (!state.currentEpisode) return;
      const cur = Math.floor(audio.currentTime || 0);
      const prog = getEpisodeProgress(state.currentEpisode.id);
      const bms = Array.isArray(prog.bookmarks) ? [...prog.bookmarks] : [];
      if (!bms.some(b => Math.abs(b.time - cur) < 2)) {
        bms.push({ time: cur, createdAt: Date.now() });
        bms.sort((a, b) => a.time - b.time);
        updateEpisodeProgress(state.currentEpisode.id, { bookmarks: bms });
        renderBookmarksInPlayer();
        showToast(`📌 Marcador guardado en ${formatTime(cur)}`);
      } else {
        showToast('Ya existe un marcador en este segundo');
      }
    });

    // Toolbar buttons in Full Player
    fpSpeedBtn.addEventListener('click', () => {
      document.querySelectorAll('#speedOptionsGrid .speed-opt').forEach(btn => {
        btn.classList.toggle('active', parseFloat(btn.getAttribute('data-speed')) === state.playbackRate);
      });
      openModal('speedModal');
    });

    document.querySelectorAll('#speedOptionsGrid .speed-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const rate = parseFloat(btn.getAttribute('data-speed')) || 1;
        state.playbackRate = rate;
        audio.playbackRate = rate;
        audio.defaultPlaybackRate = rate;
        saveSettingsToStorage();
        updatePlayerUI();
        updateMediaSessionPosition();
        closeModal('speedModal');
        showToast(`Velocidad: ${rate}x`);
      });
    });

    fpSleepBtn.addEventListener('click', () => {
      openModal('sleepModal');
    });

    document.querySelectorAll('#sleepOptionsList .sleep-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        const mins = btn.getAttribute('data-minutes');
        setSleepTimer(mins);
        closeModal('sleepModal');
      });
    });

    fpToggleCompleteBtn.addEventListener('click', () => {
      if (!state.currentEpisode) return;
      const prog = getEpisodeProgress(state.currentEpisode.id);
      const nextVal = !prog.completed;
      updateEpisodeProgress(state.currentEpisode.id, { completed: nextVal });
      updateFullPlayerCompleteButton();
      renderAll();
      showToast(nextVal ? 'Episodio marcado como completado ✓' : 'Episodio marcado como pendiente');
    });

    fpSaveOfflineBtn.addEventListener('click', () => {
      if (!state.currentEpisode) return;
      downloadEpisodeForOffline(state.currentEpisode);
    });

    // Download entire library offline button
    const downloadAllLibraryBtn = document.getElementById('downloadAllLibraryBtn');
    if (downloadAllLibraryBtn) {
      downloadAllLibraryBtn.addEventListener('click', downloadEntireLibraryOffline);
    }

    // PWA Install Prompt
    let deferredInstallPrompt = null;
    const installPwaBtn = document.getElementById('installPwaBtn');
    const navInstallBtn = document.getElementById('navInstallBtn');

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstallPrompt = e;
      if (installPwaBtn) installPwaBtn.classList.remove('hidden');
      if (navInstallBtn) navInstallBtn.classList.remove('hidden');
    });

    const triggerPwaInstall = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice && choice.outcome === 'accepted') {
          deferredInstallPrompt = null;
          if (installPwaBtn) installPwaBtn.classList.add('hidden');
          if (navInstallBtn) navInstallBtn.classList.add('hidden');
        }
      } else {
        showToast('En el menú de Chrome (⋮) toca "Agregar a la pantalla principal" o "Instalar"');
      }
    };

    if (installPwaBtn) installPwaBtn.addEventListener('click', triggerPwaInstall);
    if (navInstallBtn) navInstallBtn.addEventListener('click', triggerPwaInstall);

    // Close modals
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
      btn.addEventListener('click', () => {
        closeModal(btn.getAttribute('data-close-modal'));
      });
    });

    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop) {
          backdrop.classList.add('hidden');
        }
      });
    });
  }

  async function downloadEntireLibraryOffline() {
    const allEpisodes = [];
    for (const t of state.topics) {
      for (const ep of t.episodes) {
        if (!state.offlineEpisodeIds.has(ep.id)) {
          allEpisodes.push(ep);
        }
      }
    }

    const wrap = document.getElementById('downloadAllProgressWrap');
    const fill = document.getElementById('downloadAllProgressFill');
    const text = document.getElementById('downloadAllProgressText');
    const label = document.getElementById('downloadAllLibraryLabel');

    if (allEpisodes.length === 0) {
      showToast('✓ ¡Todos los temas y episodios ya están guardados en este dispositivo!');
      if (label) label.textContent = `✓ Todo al día (${state.offlineEpisodeIds.size} episodios en memoria)`;
      return;
    }

    if (wrap) wrap.classList.remove('hidden');
    const totalToDownload = allEpisodes.length;

    enqueueEpisodesForDownload(
      allEpisodes,
      ({ episode, pct, loadedBytes, totalBytes, completedCount }) => {
        const currentIndex = Math.min(totalToDownload, completedCount + 1);
        const overallPct = Math.min(
          99,
          Math.round(((completedCount + pct / 100) / totalToDownload) * 100)
        );
        if (fill) fill.style.width = `${overallPct}%`;
        const mbStr = totalBytes > 0
          ? ` (${(loadedBytes / (1024 * 1024)).toFixed(1)} / ${(totalBytes / (1024 * 1024)).toFixed(1)} MB)`
          : '';
        if (text) {
          text.textContent = `Guardando (${currentIndex}/${totalToDownload}): ${episode.topicName} — ${episode.title} · ${pct}%${mbStr}`;
        }
        if (label) {
          label.textContent = `⏳ Descargando (${currentIndex}/${totalToDownload}) · ${overallPct}%...`;
        }
      },
      ({ savedInRun, failedInRun }) => {
        if (failedInRun === 0) {
          if (fill) fill.style.width = '100%';
          if (text) {
            text.textContent = `✓ ¡Completado! ${state.offlineEpisodeIds.size} episodios verificados en la memoria interna del celular.`;
          }
          if (label) {
            label.textContent = `✓ Todo al día (${state.offlineEpisodeIds.size} episodios en memoria)`;
          }
          showToast(`✓ ${savedInRun} episodios guardados y verificados sin conexión`);
        } else {
          if (text) {
            text.textContent = `Se guardaron ${savedInRun} episodios. Faltaron ${failedInRun} por corte de conexión. Toca el botón arriba para reintentar solo los ${failedInRun} faltantes.`;
          }
          updateOfflineCountUI();
          showToast(`Se guardaron ${savedInRun} episodios. Toca de nuevo para descargar los ${failedInRun} faltantes.`);
        }
      }
    );
  }

  // ============================================================
  // INITIALIZATION & SERVICE WORKER
  // ============================================================
  // Surface unexpected errors on screen: on the phone there is no console to look at
  function reportRuntimeError(message) {
    const text = String(message || 'Error desconocido').slice(0, 140);
    try {
      showToast(`⚠️ Error: ${text}`);
    } catch (e) {}
  }

  function init() {
    window.addEventListener('error', e => reportRuntimeError(e.message));
    window.addEventListener('unhandledrejection', e => {
      const reason = e.reason;
      // Autoplay / interrupted-play rejections are routine on mobile, not app failures
      if (reason && (reason.name === 'NotAllowedError' || reason.name === 'AbortError')) return;
      reportRuntimeError(reason && reason.message ? reason.message : reason);
    });
    loadLocalStorageState();
    applyAppearance(state.appearance);
    bindEvents();
    loadLibrary();

    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').then(reg => reg.update()).catch(() => {});
    }
  }

  init();
})();
