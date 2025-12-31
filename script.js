// ==UserScript==
// @name         Jellyfin External Players (Batch/FullScreen/Subs)
// @namespace    yifans.tech
// @version      4.2.0
// @description  Hybrid: MPV(Batch+Subs) + PotPlayer. Fixes external subtitles & taskbar overlap.
// @match        *://*/web/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // =========================
  // Config
  // =========================
  const CONFIG = {
    // 【关键设置】Windows 系统缩放比例
    // 100% -> 1.0 | 150% -> 1.5 | 200% -> 2.0
    osScale: 2.0,

    schemeGeneric: "jelly-player",

    showOn: {
      windows: { mpv: true, pot: true },
      macOS:   { mpv: true, pot: false, iina: true, infuse: true },
      other:   { mpv: false, pot: false, iina: false, infuse: false },
    },
  };

  const PANEL_ID = "jfp-extplayers";
  const STYLE_ID = "jfp-extplayers-style";

  function log(...args) { console.log("[JFP]", ...args); }

  // =========================
  // Core: Base64 & JSON Builder
  // =========================
  function base64Encode(obj) {
    const jsonStr = JSON.stringify(obj);
    return btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g,
        (match, p1) => String.fromCharCode('0x' + p1)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildGenericUrl(payload) {
    return `${CONFIG.schemeGeneric}://${base64Encode(payload)}`;
  }

  function buildPotPlayerNativeUrl(httpUrl) {
    const safeUrl = encodeURI(httpUrl).replace(/&/g, '%26');
    return `potplayer://${safeUrl}`;
  }

  function buildIinaUrl(httpUrl) {
    return `iina://weblink?url=${encodeURIComponent(httpUrl)}&new_window=1`;
  }
  function buildInfuseUrl(httpUrl) {
    return `infuse://x-callback-url/play?url=${encodeURIComponent(httpUrl)}`;
  }

  // =========================
  // Jellyfin Data & Selection
  // =========================

  function getContext() {
    const hash = location.hash || "";
    if (hash.includes("#/details")) {
      const m = hash.match(/[?&]id=([^&]+)/i);
      return { type: 'detail', id: m ? decodeURIComponent(m[1]) : null };
    }
    const selected = getSelectedItems();
    if (selected.length > 0) {
      return { type: 'selection', ids: selected };
    }
    return { type: 'none' };
  }

  function getSelectedItems() {
    const ids = [];
    const allIcons = document.querySelectorAll('.checkboxIcon-checked');
    
    allIcons.forEach(icon => {
      if (icon.offsetParent === null) return;
      const style = window.getComputedStyle(icon);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

      const card = icon.closest('[data-id]');
      if (card) {
        ids.push(card.getAttribute('data-id'));
      }
    });

    return [...new Set(ids)];
  }

  function getOS() {
    const u = navigator.userAgent;
    if (/Windows/i.test(u)) return "windows";
    if (/Macintosh|MacIntel/i.test(u)) return "macOS";
    return "other";
  }

  async function getPlayableItem(itemId) {
    const api = window.ApiClient;
    if (!api) return null;
    const userId = api?._serverInfo?.UserId;

    let item = await api.getItem(userId, itemId);

    if (item?.Type === "Series") {
      const nextUp = await api.getNextUpEpisodes({ SeriesId: itemId, UserId: userId });
      if (nextUp?.Items?.[0]) item = await api.getItem(userId, nextUp.Items[0].Id);
    } else if (item?.Type === "Season") {
      const seasonItems = await api.getItems(userId, { parentId: itemId });
      if (seasonItems?.Items?.[0]) item = await api.getItem(userId, seasonItems.Items[0].Id);
    }
    return item;
  }

  function getStreamUrl(item) {
    const api = window.ApiClient;
    const ms = item?.MediaSources?.[0];
    if (!ms) return null;
    return (
      `${api._serverAddress}/emby/videos/${encodeURIComponent(item.Id)}/stream.${encodeURIComponent(ms.Container || "mkv")}` +
      `?api_key=${encodeURIComponent(api.accessToken())}` +
      `&Static=true` +
      `&MediaSourceId=${encodeURIComponent(ms.Id)}` +
      `&jfp=1`
    );
  }

  // 【新增】获取外挂字幕链接
  function getSubtitleUrl(item) {
    const api = window.ApiClient;
    const ms = item?.MediaSources?.[0];
    if (!ms || !ms.MediaStreams) return "";

    // 查找逻辑：
    // 1. 必须是 Subtitle 类型
    // 2. 必须是 IsExternal = true (外挂)
    // 3. 优先找 IsDefault = true 的，如果没有，则取第一个外挂字幕
    let sub = ms.MediaStreams.find(s => s.Type === 'Subtitle' && s.IsExternal && s.IsDefault);
    if (!sub) {
      sub = ms.MediaStreams.find(s => s.Type === 'Subtitle' && s.IsExternal);
    }

    if (!sub) return ""; // 没有外挂字幕

    // 构造字幕 URL: /Videos/{Id}/{MediaSourceId}/Subtitles/{Index}/Stream.{Codec}
    // 注意：必须带上 api_key，否则 MPV 下载会 401 报错
    return (
        `${api._serverAddress}/Videos/${encodeURIComponent(item.Id)}/${encodeURIComponent(ms.Id)}/Subtitles/${sub.Index}/Stream.${sub.Codec || 'srt'}` +
        `?api_key=${encodeURIComponent(api.accessToken())}`
    );
  }

  // =========================
  // Logic: Grid Calculation (Full Screen)
  // =========================

  function getGeometry(index, total) {
    if (total <= 1) return "";

    const fullW = window.screen.width;
    const fullH = window.screen.height;
    const scale = CONFIG.osScale;
    
    const W = Math.floor((fullW * scale) / 2);
    const H = Math.floor((fullH * scale) / 2);
    
    // 强制从 (0,0) 开始
    const grids = [
      `${W}x${H}+0+0`,
      `${W}x${H}+${W}+0`,
      `${W}x${H}+0+${H}`,
      `${W}x${H}+${W}+${H}`
    ];
    
    return grids[index] || "";
  }

  // =========================
  // Launchers
  // =========================

  function launchUrl(url) {
    log("launch ->", url);
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = url;
    document.body.appendChild(iframe);
    setTimeout(() => document.body.removeChild(iframe), 2000);
  }

  async function handlePlay(mode, profile) {
    const ctx = getContext();
    let targets = [];

    if (ctx.type === 'detail' && ctx.id) {
      targets = [ctx.id];
    } else if (ctx.type === 'selection' && ctx.ids) {
      targets = ctx.ids;
    }

    if (targets.length === 0) return;

    const playList = targets.slice(0, 4);

    // === MPV Batch ===
    if (mode === 'mpv') {
      const batchPayload = [];
      for (let i = 0; i < playList.length; i++) {
        const id = playList[i];
        const item = await getPlayableItem(id);
        const url = getStreamUrl(item);
        if (!url) continue;

        batchPayload.push({
          mode: 'mpv',
          url: url,
          profile: profile,
          geometry: getGeometry(i, playList.length),
          title: `Slot ${i+1}: ${item.Name}`,
          // 【核心更新】注入字幕链接
          sub: getSubtitleUrl(item) 
        });
      }
      if (batchPayload.length > 0) {
        launchUrl(buildGenericUrl(batchPayload));
      }
      return;
    }

    // === Legacy Players ===
    for (let i = 0; i < playList.length; i++) {
      const id = playList[i];
      const item = await getPlayableItem(id);
      const url = getStreamUrl(item);
      if (!url) continue;

      let finalLink = "";
      if (mode === 'pot') finalLink = buildPotPlayerNativeUrl(url);
      else if (mode === 'iina') finalLink = buildIinaUrl(url);
      else if (mode === 'infuse') finalLink = buildInfuseUrl(url);

      if (playList.length > 1) {
        setTimeout(() => launchUrl(finalLink), i * 800);
      } else {
        launchUrl(finalLink);
      }
    }
  }

  // =========================
  // UI Generation
  // =========================

  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return document.getElementById(PANEL_ID);

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        #${PANEL_ID} { position: fixed; right: 16px; bottom: 16px; z-index: 999999; display: none; gap: 8px; padding: 10px 12px; border-radius: 14px; background: rgba(20,20,20,0.85); backdrop-filter: blur(12px); box-shadow: 0 8px 32px rgba(0,0,0,0.4); align-items: center; transition: all 0.2s; }
        #${PANEL_ID} .jfp-btn { cursor: pointer; border: 0; border-radius: 10px; padding: 8px 14px; font-size: 13px; font-weight: 700; color: #111; background: #eee; white-space: nowrap; transition: transform .08s, background .2s; }
        #${PANEL_ID} .jfp-btn:hover { background: #fff; }
        #${PANEL_ID} .jfp-btn:active { transform: scale(0.96); opacity: 0.9; }
        #${PANEL_ID} .jfp-btn.primary { background: #00a4dc; color: #fff; }
        #${PANEL_ID} .jfp-btn.grid { background: #e0f2f1; color: #00695c; }
        #${PANEL_ID} .jfp-sep { width: 1px; height: 18px; opacity: .2; background: #fff; margin: 0 4px; }
        #${PANEL_ID} .jfp-info { font-size: 12px; color: #ccc; margin-left: 4px; font-family: sans-serif; pointer-events: none; }
      `;
      document.head.appendChild(style);
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
    return panel;
  }

  function renderButtons(panel, ctx) {
    const os = getOS();
    const rule = CONFIG.showOn[os] || CONFIG.showOn.other;
    panel.innerHTML = "";

    if (ctx.type === 'selection') {
      const count = ctx.ids.length;
      const btn = document.createElement("button");
      btn.className = "jfp-btn grid";
      btn.textContent = count > 1 ? `Grid Play (${Math.min(count, 4)})` : "Play Selected";
      btn.onclick = () => handlePlay('mpv', 'multi').catch(e => alert(e));
      panel.appendChild(btn);
      
      const info = document.createElement("div");
      info.className = "jfp-info";
      info.textContent = count > 4 ? "(Max 4)" : "MPV";
      panel.appendChild(info);
      return;
    }

    if (ctx.type === 'detail') {
      if (rule.mpv) {
        const btnMulti = document.createElement("button");
        btnMulti.className = "jfp-btn primary";
        btnMulti.textContent = "MPV (Multi)";
        btnMulti.onclick = () => handlePlay('mpv', 'multi');
        panel.appendChild(btnMulti);

        const btnCinema = document.createElement("button");
        btnCinema.className = "jfp-btn";
        btnCinema.textContent = "MPV (Cinema)";
        btnCinema.onclick = () => handlePlay('mpv', 'cinema');
        panel.appendChild(btnCinema);
      }
      if (rule.pot) {
        const btnPot = document.createElement("button");
        btnPot.className = "jfp-btn";
        btnPot.textContent = "PotPlayer";
        btnPot.onclick = () => handlePlay('pot');
        panel.appendChild(btnPot);
      }
      if (rule.iina) {
        const btn = document.createElement("button");
        btn.className = "jfp-btn";
        btn.textContent = "IINA";
        btn.onclick = () => handlePlay('iina');
        panel.appendChild(btn);
      }
      if (rule.infuse) {
        const btn = document.createElement("button");
        btn.className = "jfp-btn";
        btn.textContent = "Infuse";
        btn.onclick = () => handlePlay('infuse');
        panel.appendChild(btn);
      }
    }
  }

  let lastState = "";
  function tick() {
    const panel = ensurePanel();
    const ctx = getContext();
    const currentState = ctx.type + (ctx.ids ? ctx.ids.length + ctx.ids[0] : ctx.id);

    if (currentState !== lastState) {
      lastState = currentState;
      log("Context changed:", ctx);
      if (ctx.type === 'none') {
        panel.style.display = "none";
      } else {
        renderButtons(panel, ctx);
        panel.style.display = "flex";
      }
    }
    setTimeout(() => requestAnimationFrame(tick), 200);
  }

  log("v4.2.0 Subtitles & FullScreen Logic Loaded");
  tick();

})();
