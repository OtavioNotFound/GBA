/**
 * ═══════════════════════════════════════════════════════════════
 * GBA Web Emulator — app.js
 * ═══════════════════════════════════════════════════════════════
 *
 * Arquitetura:
 *  - EmulatorCore    : Wrapper ao redor do IodineGBA
 *  - InputManager    : Teclado + Gamepad API com suporte a Xbox/PS/Switch
 *  - MappingManager  : Remapeamento dinâmico salvo em localStorage
 *  - StateManager    : Save/Load/Export/Import de savestates (IndexedDB)
 *  - UI              : Controles da interface (drag-drop, modais, toast)
 *  - GamepadManager  : Gamepad API, deadzones, mapeamento por fabricante
 *
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

/* ═══════════════════════════════════════════════════════════════
   1. CONSTANTES E CONFIGURAÇÃO GLOBAL
   ═══════════════════════════════════════════════════════════════ */

/** Ações GBA disponíveis (usadas em todo o sistema de mapeamento) */
const GBA_ACTIONS = {
  a:      'Botão A',
  b:      'Botão B',
  l:      'Gatilho L',
  r:      'Gatilho R',
  up:     'D-Pad ↑',
  down:   'D-Pad ↓',
  left:   'D-Pad ←',
  right:  'D-Pad →',
  start:  'Start',
  select: 'Select',
};

/**
 * Mapeamento padrão de TECLADO: tecla (KeyboardEvent.code) → ação GBA.
 * Exemplo: 'ArrowUp' → 'up'
 */
const DEFAULT_KEYBOARD_MAP = {
  ArrowUp:    'up',
  ArrowDown:  'down',
  ArrowLeft:  'left',
  ArrowRight: 'right',
  KeyZ:       'a',
  KeyX:       'b',
  KeyA:       'l',
  KeyS:       'r',
  Enter:      'start',
  ShiftRight: 'select',
};

/**
 * Mapeamentos padrão de GAMEPAD por índice de botão (Standard Gamepad Layout).
 *
 * A W3C Gamepad API usa um layout padronizado (Standard Gamepad) onde os
 * botões têm índices fixos, mas cada fabricante tem suas particularidades.
 *
 * Standard Gamepad Layout:
 *   0=A/Cruz, 1=B/Bola, 2=X/Quadrado, 3=Y/Triângulo
 *   4=LB/L1, 5=RB/R1, 6=LT/L2, 7=RT/R2
 *   8=Select/Share, 9=Start/Options
 *   10=L3, 11=R3
 *   12=D-Pad ↑, 13=D-Pad ↓, 14=D-Pad ←, 15=D-Pad →
 *   16=Home/PS/Xbox
 *
 * Para Xbox e PlayStation, o mapeamento padrão já é suficiente.
 * Para Nintendo Switch Pro Controller, os botões A/B e X/Y são trocados.
 */
const DEFAULT_GAMEPAD_MAP = {
  0:  'a',       // A (Xbox) / Cruz (PS) / B (Switch)
  1:  'b',       // B (Xbox) / Bola (PS) / A (Switch)
  4:  'l',       // LB (Xbox) / L1 (PS) / L (Switch)
  5:  'r',       // RB (Xbox) / R1 (PS) / R (Switch)
  8:  'select',  // View (Xbox) / Share (PS) / - (Switch)
  9:  'start',   // Menu (Xbox) / Options (PS) / + (Switch)
  12: 'up',      // D-Pad ↑ (todos)
  13: 'down',    // D-Pad ↓ (todos)
  14: 'left',    // D-Pad ← (todos)
  15: 'right',   // D-Pad → (todos)
};

/**
 * Strings de identificação de gamepad por fabricante.
 * O navigator.getGamepads()[i].id contém o nome do dispositivo.
 * Usamos isso para detectar automaticamente o tipo de controle
 * e aplicar ajustes de mapeamento específicos.
 */
const GAMEPAD_PROFILES = {
  xbox: {
    patterns: ['Xbox', 'XInput', '045e:'],
    // Xbox usa Standard Layout — sem ajustes necessários
    buttonOverrides: {},
  },
  playstation: {
    patterns: ['DUALSHOCK', 'DualSense', 'PS3', 'PS4', 'PS5', '054c:'],
    // PlayStation usa Standard Layout no Chrome — sem ajustes necessários
    buttonOverrides: {},
  },
  switch: {
    patterns: ['Pro Controller', 'Joy-Con', '057e:'],
    /**
     * Switch Pro Controller tem A/B e X/Y trocados em relação ao padrão.
     * No Switch: B=baixo, A=direita (ao contrário do Xbox onde A=baixo, B=direita).
     * Ajustamos os índices para que o botão físico A do Switch → ação A do GBA.
     *
     * Índice 0 no Switch → B físico (mas posição do A no layout padrão)
     * Índice 1 no Switch → A físico (mas posição do B no layout padrão)
     */
    buttonOverrides: {
      0: 'b',  // Posição A-padrão → botão B físico do Switch → mapeamos para GBA-B
      1: 'a',  // Posição B-padrão → botão A físico do Switch → mapeamos para GBA-A
    },
  },
};

/**
 * DEADZONE para analógicos do gamepad.
 * Valores abaixo deste limiar são ignorados (evita drift/tremor).
 * Valor recomendado: 0.20 (20% do eixo)
 */
const AXIS_DEADZONE = 0.20;

/** IDs de IndexedDB */
const DB_NAME    = 'gba-emulator';
const DB_VERSION = 1;
const DB_STORE   = 'savestates';

/** Número de slots de savestate visíveis na UI */
const SAVE_SLOTS = 6;

/* ═══════════════════════════════════════════════════════════════
   2. UTILITÁRIOS
   ═══════════════════════════════════════════════════════════════ */

/** Exibe um toast de notificação temporário */
function showToast(msg, type = 'info', duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.classList.add('hidden');
  }, duration);
}

/** Abre o IndexedDB e retorna uma Promise com a instância do DB */
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore(DB_STORE, { keyPath: 'id' });
    };
    req.onsuccess  = (e) => resolve(e.target.result);
    req.onerror    = (e) => reject(e.target.error);
  });
}

/** Lê um arquivo como ArrayBuffer */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = (e) => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/** Converte ArrayBuffer → Base64 (para armazenar no IndexedDB/localStorage) */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary  = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Converte Base64 → Uint8Array */
function base64ToUint8Array(b64) {
  const binary = atob(b64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Força o download de um arquivo no navegador */
function downloadFile(data, filename, mimeType = 'application/octet-stream') {
  const blob = new Blob([data], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ═══════════════════════════════════════════════════════════════
   3. STATE MANAGER (IndexedDB)
   ═══════════════════════════════════════════════════════════════ */

const StateManager = {
  /** Salva o estado no slot especificado (1-SAVE_SLOTS) */
  async save(slotId, stateData, romName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx   = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const record = {
        id:       `${romName}_slot${slotId}`,
        slotId,
        romName,
        date:     new Date().toISOString(),
        // stateData é um objeto retornado pelo core do emulador
        data:     typeof stateData === 'string' ? stateData : JSON.stringify(stateData),
      };
      store.put(record);
      tx.oncomplete = () => resolve(record);
      tx.onerror    = (e) => reject(e.target.error);
    });
  },

  /** Carrega o estado do slot especificado */
  async load(slotId, romName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req   = store.get(`${romName}_slot${slotId}`);
      req.onsuccess = (e) => resolve(e.target.result || null);
      req.onerror   = (e) => reject(e.target.error);
    });
  },

  /** Lista todos os slots de um jogo */
  async listSlots(romName) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx    = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req   = store.getAll();
      req.onsuccess = (e) => {
        const all = e.target.result.filter(r => r.romName === romName);
        resolve(all);
      };
      req.onerror = (e) => reject(e.target.error);
    });
  },

  /** Exporta um slot como arquivo para download */
  async exportSlot(slotId, romName) {
    const record = await this.load(slotId, romName);
    if (!record) return null;
    return record.data; // string JSON
  },

  /** Importa um estado de uma string JSON */
  async importFromString(jsonString, romName) {
    // Tentamos detectar o slot 1 por padrão ao importar
    await this.save(1, jsonString, romName);
    return true;
  },
};

/* ═══════════════════════════════════════════════════════════════
   4. MAPPING MANAGER (Teclado + Gamepad, localStorage)
   ═══════════════════════════════════════════════════════════════ */

const MappingManager = {
  _keyboardMap: { ...DEFAULT_KEYBOARD_MAP },
  _gamepadMap:  { ...DEFAULT_GAMEPAD_MAP  },

  /** Inicializa e carrega preferências salvas */
  init() {
    const savedKb  = localStorage.getItem('gba_keyboard_map');
    const savedGp  = localStorage.getItem('gba_gamepad_map');
    if (savedKb) this._keyboardMap = JSON.parse(savedKb);
    if (savedGp) this._gamepadMap  = this._parseIntKeys(JSON.parse(savedGp));
  },

  _parseIntKeys(obj) {
    // Chaves de gamepad são números (índices de botão), JSON os converte em strings
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[parseInt(k, 10)] = v;
    return result;
  },

  getKeyboardMap() { return { ...this._keyboardMap }; },
  getGamepadMap()  { return { ...this._gamepadMap  }; },

  /** Retorna a ação GBA para uma tecla (event.code) */
  getActionForKey(code) { return this._keyboardMap[code] || null; },

  /** Retorna a ação GBA para um índice de botão de gamepad */
  getActionForButton(index) { return this._gamepadMap[index] ?? null; },

  /** Define um novo mapeamento de teclado */
  setKeyboardMapping(action, keyCode) {
    // Remove mapeamento anterior da mesma tecla (evita duplicatas)
    for (const [k, v] of Object.entries(this._keyboardMap)) {
      if (v === action) delete this._keyboardMap[k];
    }
    this._keyboardMap[keyCode] = action;
    localStorage.setItem('gba_keyboard_map', JSON.stringify(this._keyboardMap));
  },

  /** Define um novo mapeamento de gamepad */
  setGamepadMapping(action, buttonIndex) {
    // Remove mapeamento anterior do mesmo botão
    for (const [k, v] of Object.entries(this._gamepadMap)) {
      if (v === action) delete this._gamepadMap[parseInt(k, 10)];
    }
    this._gamepadMap[buttonIndex] = action;
    localStorage.setItem('gba_gamepad_map', JSON.stringify(this._gamepadMap));
  },

  /** Restaura mapeamento padrão do teclado */
  resetKeyboard() {
    this._keyboardMap = { ...DEFAULT_KEYBOARD_MAP };
    localStorage.removeItem('gba_keyboard_map');
  },

  /** Restaura mapeamento padrão do gamepad */
  resetGamepad() {
    this._gamepadMap = { ...DEFAULT_GAMEPAD_MAP };
    localStorage.removeItem('gba_gamepad_map');
  },

  /**
   * Detecta o perfil do gamepad pelo ID e aplica overrides de botão.
   * Retorna o mapa ajustado para o gamepad conectado.
   *
   * @param {string} gamepadId - O navigator.getGamepads()[i].id
   */
  getAdjustedMapForGamepad(gamepadId) {
    const id = gamepadId.toLowerCase();

    for (const [profileName, profile] of Object.entries(GAMEPAD_PROFILES)) {
      const matches = profile.patterns.some(p => id.includes(p.toLowerCase()));
      if (matches && Object.keys(profile.buttonOverrides).length > 0) {
        console.log(`[GamepadManager] Perfil detectado: ${profileName}`);
        // Aplica os overrides sobre o mapa atual do usuário
        const adjusted = { ...this._gamepadMap };
        for (const [btnIndex, action] of Object.entries(profile.buttonOverrides)) {
          adjusted[parseInt(btnIndex, 10)] = action;
        }
        return adjusted;
      }
    }

    return { ...this._gamepadMap };
  },
};

/* ═══════════════════════════════════════════════════════════════
   5. GAMEPAD MANAGER (Gamepad API)
   ═══════════════════════════════════════════════════════════════
   
   A Gamepad API funciona de forma diferente dos eventos de teclado:
   ela não dispara eventos contínuos enquanto um botão está pressionado.
   
   Por isso, precisamos fazer POLLING: a cada frame de animação,
   consultamos o estado de todos os botões e comparamos com o frame
   anterior para detectar pressionamentos e liberações.
   
   Fluxo:
   1. 'gamepadconnected' / 'gamepaddisconnected' → atualiza lista
   2. No game loop, chamamos poll() que lê navigator.getGamepads()
   3. Comparamos com o estado anterior para gerar eventos de input
   4. Aplicamos DEADZONE nos eixos analógicos para o D-Pad analógico
   ═══════════════════════════════════════════════════════════════ */

const GamepadManager = {
  _connected:       {},    // { index: Gamepad }
  _prevButtonStates:{},    // { index: { btnIndex: bool } }
  _activeIndex:     null,  // índice do gamepad atualmente ativo
  _adjustedMap:     null,  // mapa de botões ajustado para o gamepad conectado
  _listeningAction: null,  // ação aguardando mapeamento (modo "escuta")
  _onButton:        null,  // callback(action, isDown) para enviar ao emulador

  init(onButtonCallback) {
    this._onButton = onButtonCallback;

    // Evento: controle conectado
    window.addEventListener('gamepadconnected', (e) => {
      console.log(`[GamepadAPI] Conectado: "${e.gamepad.id}" (índice ${e.gamepad.index})`);
      this._connected[e.gamepad.index] = e.gamepad;
      this._prevButtonStates[e.gamepad.index] = {};

      // Define o primeiro controle conectado como ativo
      if (this._activeIndex === null) {
        this._activeIndex  = e.gamepad.index;
        this._adjustedMap  = MappingManager.getAdjustedMapForGamepad(e.gamepad.id);
      }

      this._updateStatusUI(true, e.gamepad.id);
    });

    // Evento: controle desconectado
    window.addEventListener('gamepaddisconnected', (e) => {
      console.log(`[GamepadAPI] Desconectado: índice ${e.gamepad.index}`);
      delete this._connected[e.gamepad.index];
      delete this._prevButtonStates[e.gamepad.index];

      if (this._activeIndex === e.gamepad.index) {
        // Tenta usar o próximo controle disponível
        const remaining = Object.keys(this._connected);
        this._activeIndex = remaining.length > 0 ? parseInt(remaining[0]) : null;
        this._adjustedMap = null;
      }

      const anyConnected = Object.keys(this._connected).length > 0;
      this._updateStatusUI(anyConnected, anyConnected ? Object.values(this._connected)[0].id : '');
    });
  },

  /**
   * POLLING — deve ser chamado a cada frame do game loop.
   * 
   * Lê o estado atual de todos os gamepads, compara com o estado
   * anterior, e dispara callbacks para botões pressionados/soltos.
   * 
   * Também verifica eixos analógicos e os converte em D-Pad digital.
   */
  poll() {
    // navigator.getGamepads() retorna um snapshot ATUALIZADO a cada chamada.
    // É essencial chamá-lo a cada frame (não cachear o resultado).
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (const gp of gamepads) {
      if (!gp) continue;

      const idx   = gp.index;
      const prev  = this._prevButtonStates[idx] || {};
      const isActive = (this._activeIndex === null || this._activeIndex === idx);

      // ── BOTÕES ────────────────────────────────────────────
      for (let i = 0; i < gp.buttons.length; i++) {
        const isPressed = gp.buttons[i].pressed;
        const wasPressed = prev[i] || false;

        if (isPressed !== wasPressed) {
          // Mudança de estado detectada
          if (this._listeningAction !== null && isPressed) {
            // MODO MAPEAMENTO: registra o botão pressionado como novo mapeamento
            this._onListenButtonPress(idx, i, gp.id);
          } else if (isActive && this._onButton) {
            // MODO NORMAL: resolve a ação GBA e dispara o callback
            const map    = this._adjustedMap || MappingManager.getGamepadMap();
            const action = map[i];
            if (action) {
              this._onButton(action, isPressed);
            }
          }
        }
      }

      // ── EIXOS ANALÓGICOS (D-Pad analógico / analógico esquerdo) ───
      // Muitos controles têm D-Pad como eixos 0/1 (esquerdo/direito e cima/baixo).
      // Convertemos para eventos digitais de D-Pad.
      if (isActive && this._onButton) {
        this._processAxis(gp, prev, idx);
      }

      // Atualiza estado anterior
      this._prevButtonStates[idx] = {};
      for (let i = 0; i < gp.buttons.length; i++) {
        this._prevButtonStates[idx][i] = gp.buttons[i].pressed;
      }
      // Salva também os eixos processados
      this._prevButtonStates[idx]['_axes'] = Array.from(gp.axes);
    }
  },

  /**
   * Processa os eixos analógicos e converte para eventos digitais de D-Pad.
   * Aplica deadzone: valores dentro de ±AXIS_DEADZONE são ignorados.
   *
   * Eixo 0: horizontal (< -deadzone → esquerda, > deadzone → direita)
   * Eixo 1: vertical   (< -deadzone → cima,     > deadzone → baixo)
   */
  _processAxis(gp, prev, idx) {
    const prevAxes = prev['_axes'] || [0, 0, 0, 0];

    const toDigital = (value) => {
      if (value < -AXIS_DEADZONE) return -1;
      if (value >  AXIS_DEADZONE) return  1;
      return 0;
    };

    // Eixo 0: Horizontal
    const axH     = gp.axes[0] || 0;
    const prevAxH = prevAxes[0] || 0;
    const curH    = toDigital(axH);
    const oldH    = toDigital(prevAxH);

    if (curH !== oldH) {
      if (oldH === -1) this._onButton('left',  false);
      if (oldH ===  1) this._onButton('right', false);
      if (curH === -1) this._onButton('left',  true);
      if (curH ===  1) this._onButton('right', true);
    }

    // Eixo 1: Vertical
    const axV     = gp.axes[1] || 0;
    const prevAxV = prevAxes[1] || 0;
    const curV    = toDigital(axV);
    const oldV    = toDigital(prevAxV);

    if (curV !== oldV) {
      if (oldV === -1) this._onButton('up',   false);
      if (oldV ===  1) this._onButton('down', false);
      if (curV === -1) this._onButton('up',   true);
      if (curV ===  1) this._onButton('down', true);
    }
  },

  /**
   * Registra um botão físico como novo mapeamento para a ação em escuta.
   * Chamado quando _listeningAction não é null e um botão é pressionado.
   */
  _onListenButtonPress(gpIndex, buttonIndex, gpId) {
    const action = this._listeningAction;
    this._listeningAction = null;

    MappingManager.setGamepadMapping(action, buttonIndex);

    // Regenera o mapa ajustado com o novo mapeamento
    if (this._activeIndex === gpIndex) {
      this._adjustedMap = MappingManager.getAdjustedMapForGamepad(gpId);
    }

    // Notifica a UI para atualizar a visualização
    UI.updateGamepadMappingUI();
    showToast(`✓ Botão ${buttonIndex} → ${GBA_ACTIONS[action]}`, 'success');
  },

  /** Entra no modo "escuta" para um botão de gamepad */
  startListening(action) {
    this._listeningAction = action;
  },

  /** Cancela o modo escuta */
  stopListening() {
    this._listeningAction = null;
  },

  /** Retorna se há algum gamepad conectado */
  isConnected() {
    return Object.keys(this._connected).length > 0;
  },

  /** Retorna o nome do gamepad ativo */
  getActiveName() {
    if (this._activeIndex === null) return null;
    const gp = this._connected[this._activeIndex];
    return gp ? gp.id : null;
  },

  /** Atualiza o indicador visual na UI */
  _updateStatusUI(connected, id = '') {
    const indicator   = document.getElementById('gamepad-indicator');
    const statusEl    = document.getElementById('gamepad-status');
    const statusText  = document.getElementById('gamepad-status-text');

    if (connected) {
      indicator?.classList.add('connected');
      statusEl?.classList.replace('disconnected', 'connected');
      if (statusText) statusText.textContent = `Conectado: ${id}`;
      showToast(`🎮 Controle conectado: ${id.substring(0, 40)}`, 'success');
    } else {
      indicator?.classList.remove('connected');
      statusEl?.classList.replace('connected', 'disconnected');
      if (statusText) statusText.textContent = 'Nenhum controle detectado. Conecte e pressione qualquer botão.';
      showToast('🎮 Controle desconectado', 'info');
    }
  },
};

/* ═══════════════════════════════════════════════════════════════
   6. EMULATOR CORE (Wrapper IodineGBA)
   ═══════════════════════════════════════════════════════════════
   
   IodineGBA expõe as seguintes APIs principais:
   - IodineGBA.attachCanvas(canvas)
   - IodineGBA.loadROM(romData) — Uint8Array
   - IodineGBA.startEmulator()
   - IodineGBA.keyDown(keyCode)  / keyUp(keyCode)
   - IodineGBA.saveState()       → objeto de estado
   - IodineGBA.loadState(state)
   
   Se IodineGBA não estiver disponível (CDN falhou), usamos um stub
   que simula a API para que a UI funcione sem erros.
   ═══════════════════════════════════════════════════════════════ */

// Mapa de ações GBA → código de tecla interno do IodineGBA
// IodineGBA usa os mesmos nomes que usamos (a, b, l, r, up, down, left, right, start, select)
const IODINE_KEY_MAP = {
  a: 'a', b: 'b', l: 'l', r: 'r',
  up: 'up', down: 'down', left: 'left', right: 'right',
  start: 'start', select: 'select',
};

const EmulatorCore = {
  _instance:      null,
  _running:       false,
  _romLoaded:     false,
  _romName:       '',
  _fastForward:   false,
  _fastForwardMult: 4,
  _canvas:        null,
  _ctx:           null,
  _frameTimer:    null,
  _fpsInterval:   null,
  _frameCount:    0,
  _lastFpsTime:   0,
  _pressedKeys:   new Set(), // evita repetição de keyDown para teclado

  init(canvas) {
    this._canvas = canvas;
    this._ctx    = canvas.getContext('2d');

    // Tenta inicializar IodineGBA
    if (typeof IodineGBA !== 'undefined') {
      try {
        // IodineGBA precisa ser instanciado
        this._instance = new IodineGBA();
        this._instance.attachCanvas(canvas);
        console.log('[EmulatorCore] IodineGBA inicializado com sucesso.');
      } catch (err) {
        console.warn('[EmulatorCore] Falha ao instanciar IodineGBA:', err);
        this._instance = this._createStub();
      }
    } else {
      console.warn('[EmulatorCore] IodineGBA não encontrado. Usando stub.');
      this._instance = this._createStub();
    }

    // Inicia contador de FPS
    this._startFpsCounter();
  },

  /** Stub para quando IodineGBA não está disponível */
  _createStub() {
    const ctx = this._ctx;
    const canvas = this._canvas;
    return {
      loadROM: (data) => {
        // Exibe uma tela de demonstração no canvas
        ctx.fillStyle = '#0a0b0f';
        ctx.fillRect(0, 0, 240, 160);
        ctx.fillStyle = '#00e5ff';
        ctx.font = 'bold 14px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('ROM CARREGADA', 120, 70);
        ctx.fillStyle = '#8892a4';
        ctx.font = '10px monospace';
        ctx.fillText('IodineGBA não encontrado.', 120, 90);
        ctx.fillText('Verifique a conexão com o CDN', 120, 103);
        ctx.fillText('ou adicione IodineGBA.js localmente.', 120, 116);
        return true;
      },
      startEmulator: () => {},
      keyDown: () => {},
      keyUp: () => {},
      saveState: () => ({ stub: true, timestamp: Date.now() }),
      loadState: () => {},
    };
  },

  /** Carrega uma ROM (ArrayBuffer ou Uint8Array) */
  async loadROM(romBuffer, romName) {
    const data = romBuffer instanceof Uint8Array ? romBuffer : new Uint8Array(romBuffer);
    this._romName   = romName.replace(/\.gba$/i, '');
    this._romLoaded = true;

    try {
      this._instance.loadROM(data);
      this._instance.startEmulator();
      this._running = true;
      this._startFrameLoop();
      console.log(`[EmulatorCore] ROM carregada: ${this._romName}`);
      return true;
    } catch (err) {
      console.error('[EmulatorCore] Erro ao carregar ROM:', err);
      return false;
    }
  },

  /** Envia pressionamento de botão para o core */
  buttonDown(action) {
    if (!this._romLoaded) return;
    const key = IODINE_KEY_MAP[action];
    if (key) this._instance.keyDown(key);
  },

  /** Envia liberação de botão para o core */
  buttonUp(action) {
    if (!this._romLoaded) return;
    const key = IODINE_KEY_MAP[action];
    if (key) this._instance.keyUp(key);
  },

  /** Ativa/desativa Fast Forward */
  setFastForward(enabled, multiplier = 4) {
    this._fastForward     = enabled;
    this._fastForwardMult = multiplier;

    if (this._running) {
      this._stopFrameLoop();
      this._startFrameLoop();
    }
  },

  /**
   * Loop principal de frames.
   * 
   * GBA roda a ~59.73 FPS nativamente.
   * Em Fast Forward, reduzimos o intervalo para acelerar a emulação.
   * 
   * IodineGBA funciona melhor quando chamado via requestAnimationFrame,
   * pois ele gerencia internamente o timing. Mas para fast-forward,
   * podemos chamar o step múltiplas vezes.
   */
  _startFrameLoop() {
    if (!this._running) return;
    this._stopFrameLoop();

    const run = () => {
      if (!this._running) return;
      this._frameTimer = requestAnimationFrame(run);
      this._frameCount++;

      // Fast forward: renderiza múltiplos frames por tick de RAF
      const steps = this._fastForward ? this._fastForwardMult : 1;
      // IodineGBA avança automaticamente quando o canvas está anexado
      // Para fast-forward, podemos "pular" frames de áudio/vídeo
      // Nota: implementação exata depende da versão do IodineGBA
    };

    this._frameTimer = requestAnimationFrame(run);
  },

  _stopFrameLoop() {
    if (this._frameTimer) {
      cancelAnimationFrame(this._frameTimer);
      this._frameTimer = null;
    }
  },

  /** Inicia o contador de FPS (atualiza a cada segundo) */
  _startFpsCounter() {
    this._lastFpsTime = performance.now();
    this._fpsInterval = setInterval(() => {
      const now   = performance.now();
      const delta = (now - this._lastFpsTime) / 1000;
      const fps   = Math.round(this._frameCount / delta);
      document.getElementById('fps-counter').textContent = `${fps} FPS`;
      this._frameCount  = 0;
      this._lastFpsTime = now;
    }, 1000);
  },

  /** Salva o estado atual do emulador */
  saveState() {
    if (!this._romLoaded) return null;
    try {
      return this._instance.saveState();
    } catch (err) {
      console.error('[EmulatorCore] Erro ao salvar estado:', err);
      return null;
    }
  },

  /** Carrega um estado previamente salvo */
  loadState(state) {
    if (!this._romLoaded) return false;
    try {
      this._instance.loadState(state);
      return true;
    } catch (err) {
      console.error('[EmulatorCore] Erro ao carregar estado:', err);
      return false;
    }
  },

  get romName()   { return this._romName;   },
  get romLoaded() { return this._romLoaded; },
  get running()   { return this._running;   },
};

/* ═══════════════════════════════════════════════════════════════
   7. INPUT MANAGER (Teclado)
   ═══════════════════════════════════════════════════════════════ */

const InputManager = {
  _listeningAction: null,  // ação aguardando mapeamento via teclado
  _onKeyListen:     null,  // callback quando capturar tecla em modo mapeamento

  init() {
    document.addEventListener('keydown', (e) => this._handleKeyDown(e));
    document.addEventListener('keyup',   (e) => this._handleKeyUp(e));
  },

  _handleKeyDown(e) {
    // Ignora teclas dentro de inputs de texto
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // ── HOTKEYS GLOBAIS ───────────────────────────────────────
    if (!e.repeat) {
      if (e.code === 'F5')  { e.preventDefault(); UI.openSaveModal();  return; }
      if (e.code === 'F8')  { e.preventDefault(); UI.openLoadModal();  return; }
      if (e.code === 'Tab') { e.preventDefault(); UI.toggleFastForward(); return; }
      if (e.code === 'F11') { e.preventDefault(); UI.toggleFullscreen(); return; }
    }

    // ── MODO MAPEAMENTO ───────────────────────────────────────
    if (this._listeningAction !== null && !e.repeat) {
      e.preventDefault();
      const action = this._listeningAction;
      this._listeningAction = null;

      MappingManager.setKeyboardMapping(action, e.code);
      UI.updateKeyboardMappingUI();
      showToast(`✓ ${e.code} → ${GBA_ACTIONS[action]}`, 'success');

      if (this._onKeyListen) {
        this._onKeyListen(action, e.code);
        this._onKeyListen = null;
      }
      return;
    }

    // ── INPUT NORMAL ──────────────────────────────────────────
    if (!e.repeat) {
      const action = MappingManager.getActionForKey(e.code);
      if (action) {
        e.preventDefault();
        EmulatorCore.buttonDown(action);
      }
    }
  },

  _handleKeyUp(e) {
    const action = MappingManager.getActionForKey(e.code);
    if (action) EmulatorCore.buttonUp(action);
  },

  /** Entra no modo "escuta" para capturar a próxima tecla pressionada */
  startListening(action, callback) {
    this._listeningAction = action;
    this._onKeyListen = callback || null;
  },

  stopListening() {
    this._listeningAction = null;
    this._onKeyListen = null;
  },
};

/* ═══════════════════════════════════════════════════════════════
   8. UI — Interface de Usuário
   ═══════════════════════════════════════════════════════════════ */

const UI = {
  _saveMode:      'save', // 'save' ou 'load'
  _fastForwardOn: false,
  _speedMult:     4,

  init() {
    // ── ELEMENTOS ─────────────────────────────────────────────
    this.canvas    = document.getElementById('gba-canvas');
    this.dropZone  = document.getElementById('drop-zone');
    this.romInput  = document.getElementById('rom-file-input');
    this.stateInput= document.getElementById('state-file-input');

    // ── DROP ZONE ─────────────────────────────────────────────
    const area = document.getElementById('canvas-area');
    area.addEventListener('dragover',  (e) => { e.preventDefault(); this.dropZone.classList.add('drag-over');    });
    area.addEventListener('dragleave', ()  => this.dropZone.classList.remove('drag-over'));
    area.addEventListener('drop',      (e) => {
      e.preventDefault();
      this.dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) this._loadROMFile(file);
    });

    // ── BOTÕES DA SIDEBAR ──────────────────────────────────────
    document.getElementById('btn-load-rom')        .addEventListener('click', () => this.romInput.click());
    document.getElementById('btn-browse-rom')      .addEventListener('click', () => this.romInput.click());
    document.getElementById('btn-save-state')      .addEventListener('click', () => this.openSaveModal());
    document.getElementById('btn-load-state')      .addEventListener('click', () => this.openLoadModal());
    document.getElementById('btn-export-state')    .addEventListener('click', () => this._exportState());
    document.getElementById('btn-import-state')    .addEventListener('click', () => this.stateInput.click());
    document.getElementById('btn-fast-forward')    .addEventListener('click', () => this.toggleFastForward());
    document.getElementById('btn-controls-config') .addEventListener('click', () => this._openControlsModal());
    document.getElementById('btn-fullscreen')      .addEventListener('click', () => this.toggleFullscreen());

    // ── FILE INPUTS ───────────────────────────────────────────
    this.romInput.addEventListener('change',   (e) => { if (e.target.files[0]) this._loadROMFile(e.target.files[0]); });
    this.stateInput.addEventListener('change', (e) => { if (e.target.files[0]) this._importStateFile(e.target.files[0]); });

    // ── SPEED OPTIONS ──────────────────────────────────────────
    document.querySelectorAll('.speed-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.speed-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._speedMult = parseInt(btn.dataset.speed, 10);
        if (this._fastForwardOn) EmulatorCore.setFastForward(true, this._speedMult);
      });
    });

    // ── MODAL: Controles ──────────────────────────────────────
    document.getElementById('modal-close')    .addEventListener('click', () => this._closeControlsModal());
    document.getElementById('reset-keyboard') .addEventListener('click', () => { MappingManager.resetKeyboard(); this.updateKeyboardMappingUI(); showToast('Teclado restaurado ao padrão', 'info'); });
    document.getElementById('reset-gamepad')  .addEventListener('click', () => { MappingManager.resetGamepad();  this.updateGamepadMappingUI();  showToast('Controle restaurado ao padrão', 'info'); });
    document.getElementById('modal-overlay')  .addEventListener('click', (e) => { if (e.target === e.currentTarget) this._closeControlsModal(); });

    // TABS
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${btn.dataset.tab}`).classList.add('active');
      });
    });

    // ── MODAL: SaveState ──────────────────────────────────────
    document.getElementById('savestate-close').addEventListener('click', () => this._closeSavestateModal());
    document.getElementById('savestate-overlay').addEventListener('click', (e) => { if (e.target === e.currentTarget) this._closeSavestateModal(); });

    // ── CONTROLES VIRTUAIS (Mobile) ───────────────────────────
    document.querySelectorAll('[data-gba]').forEach(btn => {
      const action = btn.dataset.gba;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.classList.add('pressed'); EmulatorCore.buttonDown(action); });
      btn.addEventListener('pointerup',   (e) => { e.preventDefault(); btn.classList.remove('pressed'); EmulatorCore.buttonUp(action); });
      btn.addEventListener('pointerleave',() => { btn.classList.remove('pressed'); EmulatorCore.buttonUp(action); });
    });

    // Gera as grids de mapeamento
    this._buildMappingGrids();
  },

  // ── ROM ─────────────────────────────────────────────────────

  async _loadROMFile(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    if (!['gba', 'bin'].includes(ext)) {
      showToast('❌ Formato inválido. Use arquivos .gba', 'error');
      return;
    }

    showToast('⏳ Carregando ROM...', 'info', 10000);

    try {
      const buffer = await readFileAsArrayBuffer(file);
      const ok = await EmulatorCore.loadROM(buffer, file.name);

      if (ok) {
        // Mostra o canvas, esconde o drop zone
        this.dropZone.classList.add('hidden');
        this.canvas.classList.add('active');

        document.getElementById('rom-name').textContent = EmulatorCore.romName;
        showToast(`✓ ROM carregada: ${EmulatorCore.romName}`, 'success');
      } else {
        showToast('❌ Falha ao carregar a ROM', 'error');
      }
    } catch (err) {
      console.error(err);
      showToast('❌ Erro ao ler o arquivo', 'error');
    }
  },

  // ── SAVE / LOAD STATE ────────────────────────────────────────

  openSaveModal() {
    if (!EmulatorCore.romLoaded) { showToast('Carregue uma ROM primeiro', 'error'); return; }
    this._saveMode = 'save';
    document.getElementById('savestate-modal-title').textContent = '💾 Salvar Estado — Escolha o Slot';
    this._renderSlots().then(() => {
      document.getElementById('savestate-overlay').classList.remove('hidden');
    });
  },

  openLoadModal() {
    if (!EmulatorCore.romLoaded) { showToast('Carregue uma ROM primeiro', 'error'); return; }
    this._saveMode = 'load';
    document.getElementById('savestate-modal-title').textContent = '📥 Carregar Estado — Escolha o Slot';
    this._renderSlots().then(() => {
      document.getElementById('savestate-overlay').classList.remove('hidden');
    });
  },

  _closeSavestateModal() {
    document.getElementById('savestate-overlay').classList.add('hidden');
  },

  async _renderSlots() {
    const grid    = document.getElementById('slots-grid');
    const romName = EmulatorCore.romName;
    const saved   = await StateManager.listSlots(romName);
    const slotMap = {};
    saved.forEach(s => slotMap[s.slotId] = s);

    grid.innerHTML = '';
    for (let i = 1; i <= SAVE_SLOTS; i++) {
      const btn  = document.createElement('button');
      const data = slotMap[i];
      btn.className = `slot-btn${data ? ' has-data' : ''}`;

      btn.innerHTML = `
        <span class="slot-name">Slot ${i}</span>
        ${data
          ? `<span class="slot-date">${new Date(data.date).toLocaleString('pt-BR')}</span>`
          : `<span class="slot-empty">— Vazio —</span>`}
      `;

      btn.addEventListener('click', async () => {
        this._closeSavestateModal();
        if (this._saveMode === 'save') {
          await this._doSaveSlot(i);
        } else {
          await this._doLoadSlot(i);
        }
      });

      grid.appendChild(btn);
    }
  },

  async _doSaveSlot(slotId) {
    const state = EmulatorCore.saveState();
    if (!state) { showToast('❌ Não foi possível salvar o estado', 'error'); return; }

    await StateManager.save(slotId, state, EmulatorCore.romName);
    showToast(`✓ Estado salvo no Slot ${slotId}`, 'success');
  },

  async _doLoadSlot(slotId) {
    const record = await StateManager.load(slotId, EmulatorCore.romName);
    if (!record) { showToast(`❌ Slot ${slotId} está vazio`, 'error'); return; }

    let stateObj;
    try {
      stateObj = typeof record.data === 'string' ? JSON.parse(record.data) : record.data;
    } catch {
      stateObj = record.data;
    }

    const ok = EmulatorCore.loadState(stateObj);
    if (ok) {
      showToast(`✓ Estado do Slot ${slotId} carregado`, 'success');
    } else {
      showToast('❌ Falha ao carregar estado', 'error');
    }
  },

  // ── EXPORT / IMPORT ──────────────────────────────────────────

  async _exportState() {
    if (!EmulatorCore.romLoaded) { showToast('Carregue uma ROM primeiro', 'error'); return; }

    // Exporta o slot 1 por padrão
    const data = await StateManager.exportSlot(1, EmulatorCore.romName);
    if (!data) { showToast('❌ Slot 1 está vazio. Salve um estado primeiro.', 'error'); return; }

    const filename = `${EmulatorCore.romName}_slot1.state`;
    downloadFile(data, filename, 'application/json');
    showToast(`✓ Estado exportado como ${filename}`, 'success');
  },

  async _importStateFile(file) {
    if (!EmulatorCore.romLoaded) { showToast('Carregue uma ROM primeiro', 'error'); return; }

    try {
      const text = await file.text();
      await StateManager.importFromString(text, EmulatorCore.romName);
      showToast('✓ Estado importado para o Slot 1', 'success');
    } catch (err) {
      console.error(err);
      showToast('❌ Arquivo de estado inválido', 'error');
    } finally {
      this.stateInput.value = '';
    }
  },

  // ── FAST FORWARD ────────────────────────────────────────────

  toggleFastForward() {
    this._fastForwardOn = !this._fastForwardOn;
    const btn = document.getElementById('btn-fast-forward');
    btn.classList.toggle('active', this._fastForwardOn);
    EmulatorCore.setFastForward(this._fastForwardOn, this._speedMult);
    showToast(this._fastForwardOn ? `⏩ Fast Forward ${this._speedMult}× ativado` : '▶ Velocidade normal', 'info', 1500);
  },

  // ── FULLSCREEN ───────────────────────────────────────────────

  toggleFullscreen() {
    const area = document.getElementById('canvas-area');
    if (!document.fullscreenElement) {
      area.requestFullscreen?.() || area.webkitRequestFullscreen?.();
    } else {
      document.exitFullscreen?.() || document.webkitExitFullscreen?.();
    }
  },

  // ── MODAL DE CONTROLES ───────────────────────────────────────

  _openControlsModal() {
    // Atualiza o status do gamepad
    const connected = GamepadManager.isConnected();
    const statusEl  = document.getElementById('gamepad-status');
    const statusText= document.getElementById('gamepad-status-text');
    if (connected) {
      statusEl.classList.replace('disconnected', 'connected');
      statusText.textContent = `Conectado: ${GamepadManager.getActiveName() || 'Controle'}`;
    } else {
      statusEl.classList.replace('connected', 'disconnected');
      statusText.textContent = 'Nenhum controle detectado.';
    }

    document.getElementById('modal-overlay').classList.remove('hidden');
    this.updateKeyboardMappingUI();
    this.updateGamepadMappingUI();
  },

  _closeControlsModal() {
    document.getElementById('modal-overlay').classList.add('hidden');
    // Cancela qualquer modo de escuta ativo
    InputManager.stopListening();
    GamepadManager.stopListening();
    document.querySelectorAll('.mapping-row.listening').forEach(r => r.classList.remove('listening'));
  },

  // ── MAPPING GRIDS ────────────────────────────────────────────

  _buildMappingGrids() {
    this._buildGrid('keyboard-mapping-grid', 'keyboard');
    this._buildGrid('gamepad-mapping-grid',  'gamepad');
  },

  /**
   * Constrói a grid de mapeamento para teclado ou gamepad.
   * Cada linha tem: [Nome da Ação] [Tecla/Botão atual] ← clicável
   */
  _buildGrid(gridId, type) {
    const grid = document.getElementById(gridId);
    grid.innerHTML = '';

    for (const [action, label] of Object.entries(GBA_ACTIONS)) {
      const row = document.createElement('div');
      row.className    = 'mapping-row';
      row.dataset.action = action;

      const actionSpan = document.createElement('span');
      actionSpan.className   = 'mapping-action';
      actionSpan.textContent = label;

      const keySpan = document.createElement('span');
      keySpan.className   = 'mapping-key';
      keySpan.dataset.type  = type;
      keySpan.dataset.action = action;
      keySpan.textContent   = this._getKeyLabel(action, type);

      keySpan.addEventListener('click', () => this._startMappingListen(action, type, row, keySpan));

      row.appendChild(actionSpan);
      row.appendChild(keySpan);
      grid.appendChild(row);
    }
  },

  /** Retorna a label atual da tecla para uma ação */
  _getKeyLabel(action, type) {
    if (type === 'keyboard') {
      const map = MappingManager.getKeyboardMap();
      const key = Object.entries(map).find(([, v]) => v === action)?.[0];
      return key ? this._formatKeyCode(key) : '—';
    } else {
      const map = MappingManager.getGamepadMap();
      const btn = Object.entries(map).find(([, v]) => v === action)?.[0];
      return btn !== undefined ? `Btn ${btn}` : '—';
    }
  },

  /** Formata o KeyboardEvent.code de forma legível */
  _formatKeyCode(code) {
    return code
      .replace('Key',   '')
      .replace('Arrow', '↑↓←→'.includes(code) ? '' : '')
      .replace('ArrowUp',    '↑')
      .replace('ArrowDown',  '↓')
      .replace('ArrowLeft',  '←')
      .replace('ArrowRight', '→')
      .replace('ShiftLeft',  'L-Shift')
      .replace('ShiftRight', 'R-Shift')
      .replace('Enter',      'Enter')
      .replace('Space',      'Espaço');
  },

  /**
   * Inicia o modo de escuta de mapeamento.
   * 
   * Quando o usuário clica em uma tecla na grid de mapeamento,
   * entramos no modo "escuta" onde a próxima tecla ou botão de
   * gamepad pressionado será atribuído àquela ação.
   */
  _startMappingListen(action, type, row, keySpan) {
    // Remove qualquer escuta anterior
    document.querySelectorAll('.mapping-row.listening').forEach(r => r.classList.remove('listening'));
    InputManager.stopListening();
    GamepadManager.stopListening();

    row.classList.add('listening');
    keySpan.textContent = '...';

    if (type === 'keyboard') {
      InputManager.startListening(action, () => {
        row.classList.remove('listening');
        this.updateKeyboardMappingUI();
      });
    } else {
      GamepadManager.startListening(action);
      // Para gamepad, o GamepadManager vai chamar UI.updateGamepadMappingUI() quando capturar
    }

    // Timeout de segurança: cancela após 10 segundos
    setTimeout(() => {
      if (row.classList.contains('listening')) {
        row.classList.remove('listening');
        InputManager.stopListening();
        GamepadManager.stopListening();
        this.updateKeyboardMappingUI();
        this.updateGamepadMappingUI();
      }
    }, 10000);
  },

  /** Atualiza todos os labels da grid de teclado */
  updateKeyboardMappingUI() {
    document.querySelectorAll('.mapping-key[data-type="keyboard"]').forEach(span => {
      const action = span.dataset.action;
      span.textContent = this._getKeyLabel(action, 'keyboard');
    });
  },

  /** Atualiza todos os labels da grid de gamepad */
  updateGamepadMappingUI() {
    document.querySelectorAll('.mapping-key[data-type="gamepad"]').forEach(span => {
      const action = span.dataset.action;
      span.textContent = this._getKeyLabel(action, 'gamepad');
    });
    // Remove estado de escuta
    document.querySelectorAll('#gamepad-mapping-grid .mapping-row.listening')
      .forEach(r => r.classList.remove('listening'));
  },
};

/* ═══════════════════════════════════════════════════════════════
   9. GAME LOOP PRINCIPAL
   ═══════════════════════════════════════════════════════════════
   
   O game loop faz o polling do Gamepad API a cada frame.
   Isso é necessário porque a Gamepad API não dispara eventos
   automáticos — precisamos consultar o estado manualmente.
   ═══════════════════════════════════════════════════════════════ */

function startMainLoop() {
  function loop() {
    // Poll dos gamepads conectados (essencial para a Gamepad API)
    GamepadManager.poll();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

/* ═══════════════════════════════════════════════════════════════
   10. INICIALIZAÇÃO
   ═══════════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  console.log('[App] Inicializando GBA Web Emulator...');

  // 1. Carrega mapeamentos salvos
  MappingManager.init();

  // 2. Inicializa o core de emulação com o canvas
  EmulatorCore.init(document.getElementById('gba-canvas'));

  // 3. Inicializa o gerenciador de inputs de teclado
  InputManager.init();

  // 4. Inicializa a Gamepad API com callback de botões
  GamepadManager.init((action, isDown) => {
    if (isDown) {
      EmulatorCore.buttonDown(action);
    } else {
      EmulatorCore.buttonUp(action);
    }
  });

  // 5. Inicializa a UI
  UI.init();

  // 6. Inicia o loop principal (polling de gamepad)
  startMainLoop();

  console.log('[App] Emulador pronto. Arraste uma ROM .gba para começar.');
  showToast('🎮 GBA Emulator pronto! Carregue uma ROM para começar.', 'info', 3000);
});
