+/**
 * Jogo da Velha 2 – Ultimate Tic-Tac-Toe
 * Cliente: suporta modo Local (mesma tela) e Online (WebSocket + salas, persistência e reconexão)
 */

    'use strict';

// ── Constantes ────────────────────────────────────────────────────────────────

const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
];

// ── Estado global ─────────────────────────────────────────────────────────────

let state = {};
let players = { X: 'Jogador X', O: 'Jogador O' };
let mode = 'local';   // 'local' | 'online'
let mySymbol = null;      // 'X' | 'O' (online)
let playerId = null;      // ID único da sessão (online)
let roomCode = null;      // Código da sala atual
let socket = null;
let scoreX = 0;
let scoreO = 0;
let startingPlayer = 'X'; // Quem começa a partida atual; alterna a cada revanche
let currentUser = '';
let currentPairScore = { X: 0, O: 0, draws: 0, total: 0 };
let localMatchRecorded = false;
let currentReplayMoves = [];
let currentReplayIndex = 0;
let disconnectInterval = null;

const LOGIN_KEY = 'tictactoe2_current_user';
const LOCAL_HISTORY_KEY = 'tictactoe2_match_history';

function createInitialState(firstPlayer) {
    return {
        cells: Array.from({ length: 9 }, () => Array(9).fill(null)),
        macroBoard: Array(9).fill(null),
        currentPlayer: firstPlayer || 'X',
        activeBoard: null,
        gameOver: false,
        winner: null,
        winLine: null,
        matchRecorded: false
    };
}

function cleanPlayerName(name, fallback = 'Jogador') {
    return (name || '').trim().slice(0, 16) || fallback;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

function playerKey(name) {
    return cleanPlayerName(name).toLocaleLowerCase('pt-BR');
}

function getPairKey(nameA, nameB) {
    return [playerKey(nameA), playerKey(nameB)].sort().join('::');
}

function loadLocalHistory() {
    try {
        return JSON.parse(localStorage.getItem(LOCAL_HISTORY_KEY)) || { pairs: {}, matches: [] };
    } catch (e) {
        return { pairs: {}, matches: [] };
    }
}

function saveLocalHistory(history) {
    localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(history));
}

function getLocalPairRecord(nameA, nameB) {
    const history = loadLocalHistory();
    const key = getPairKey(nameA, nameB);
    if (!history.pairs[key]) {
        const ordered = [cleanPlayerName(nameA), cleanPlayerName(nameB)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        history.pairs[key] = {
            players: ordered,
            wins: { [ordered[0]]: 0, [ordered[1]]: 0 },
            draws: 0,
            total: 0,
            lastPlayed: null
        };
        saveLocalHistory(history);
    }
    return history.pairs[key];
}

function getLocalPairScore(nameX, nameO) {
    const record = getLocalPairRecord(nameX, nameO);
    return {
        X: record.wins[cleanPlayerName(nameX)] || 0,
        O: record.wins[cleanPlayerName(nameO)] || 0,
        draws: record.draws || 0,
        total: record.total || 0
    };
}

function recordLocalMatch(winnerSymbol) {
    const history = loadLocalHistory();
    const nameX = cleanPlayerName(players.X, 'Jogador X');
    const nameO = cleanPlayerName(players.O, 'Jogador O');
    const key = getPairKey(nameX, nameO);
    if (!history.pairs[key]) {
        const ordered = [nameX, nameO].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        history.pairs[key] = {
            players: ordered,
            wins: { [ordered[0]]: 0, [ordered[1]]: 0 },
            draws: 0,
            total: 0,
            lastPlayed: null
        };
    }

    const record = history.pairs[key];
    const winnerName = winnerSymbol === 'X' ? nameX : winnerSymbol === 'O' ? nameO : null;
    record.total += 1;
    record.lastPlayed = new Date().toISOString();
    if (winnerName) record.wins[winnerName] = (record.wins[winnerName] || 0) + 1;
    else record.draws += 1;

    history.matches.unshift({
        players: { X: nameX, O: nameO },
        winner: winnerName || 'Empate',
        winnerSymbol,
        playedAt: record.lastPlayed
    });
    history.matches = history.matches.slice(0, 200);
    saveLocalHistory(history);
    currentPairScore = getLocalPairScore(nameX, nameO);
    applyPairScoreToScoreboard();
    renderHistory();
}

function applyPairScoreToScoreboard() {
    scoreX = currentPairScore.X || 0;
    scoreO = currentPairScore.O || 0;
    updateMatchRecord();
}

function updateMatchRecord() {
    const el = document.getElementById('match-record');
    if (!el) return;
    el.textContent = `Placar do confronto: ${players.X} ${scoreX} x ${scoreO} ${players.O}`;
}

function updateLocalVersusPreview() {
    const el = document.getElementById('local-versus-record');
    if (!el) return;
    const nameX = cleanPlayerName(document.getElementById('input-x').value, 'Jogador X');
    const nameO = cleanPlayerName(document.getElementById('input-o').value, 'Jogador O');
    if (!nameX || !nameO) {
        el.classList.add('hidden');
        return;
    }
    const pair = getLocalPairScore(nameX, nameO);
    el.textContent = `Histórico: ${nameX} ${pair.X} x ${pair.O} ${nameO}`;
    el.classList.remove('hidden');
}

function setCurrentUser(name) {
    currentUser = cleanPlayerName(name);
    localStorage.setItem(LOGIN_KEY, currentUser);
    updateAuthUI();
    renderHistory();
    connectWS(() => {
        wsSend({ type: 'enterLobby', name: getMyName() });
    });
}

function logoutUser() {
    currentUser = '';
    localStorage.removeItem(LOGIN_KEY);
    clearSession();
    updateAuthUI();
    renderHistory();
    disconnectWS();
}

function updateAuthUI() {
    const authContainer = document.getElementById('auth-container');
    const loggedInContainer = document.getElementById('logged-in-container');
    const loggedInUsername = document.getElementById('logged-in-username');
    const lobbyContent = document.getElementById('lobby-content');

    if (currentUser) {
        if (authContainer) authContainer.classList.add('hidden');
        if (loggedInContainer) loggedInContainer.classList.remove('hidden');
        if (loggedInUsername) loggedInUsername.textContent = currentUser;
        if (lobbyContent) lobbyContent.classList.remove('hidden');
    } else {
        if (authContainer) authContainer.classList.remove('hidden');
        if (loggedInContainer) loggedInContainer.classList.add('hidden');
        if (loggedInUsername) loggedInUsername.textContent = 'Nenhum';
        if (lobbyContent) lobbyContent.classList.add('hidden');

        // Limpar inputs
        const lUser = document.getElementById('login-username');
        const lPass = document.getElementById('login-password');
        const rUser = document.getElementById('register-username');
        const rPass = document.getElementById('register-password');
        const rConf = document.getElementById('register-confirm');
        const errEl = document.getElementById('auth-error-msg');

        if (lUser) lUser.value = '';
        if (lPass) lPass.value = '';
        if (rUser) rUser.value = '';
        if (rPass) rPass.value = '';
        if (rConf) rConf.value = '';
        if (errEl) errEl.classList.add('hidden');
    }
}

async function loginUser(username, password) {
    const errorEl = document.getElementById('auth-error-msg');
    if (errorEl) errorEl.classList.add('hidden');
    try {
        const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            setCurrentUser(data.username);
        } else {
            showAuthError(data.error || 'Erro ao fazer login.');
        }
    } catch (e) {
        showAuthError('Erro de conexão com o servidor.');
    }
}

async function registerUser(username, password) {
    const errorEl = document.getElementById('auth-error-msg');
    if (errorEl) errorEl.classList.add('hidden');
    try {
        const res = await fetch('/api/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
            setCurrentUser(data.username);
        } else {
            showAuthError(data.error || 'Erro ao criar conta.');
        }
    } catch (e) {
        showAuthError('Erro de conexão com o servidor.');
    }
}

function showAuthError(msg) {
    const errorEl = document.getElementById('auth-error-msg');
    if (!errorEl) return;
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
    errorEl.classList.remove('shake');
    void errorEl.offsetWidth;
    errorEl.classList.add('shake');
}

async function fetchServerHistory(playerName) {
    try {
        const res = await fetch(`/api/history?player=${encodeURIComponent(playerName)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.pairs || [];
    } catch (e) {
        return [];
    }
}

async function renderHistory() {
    const list = document.getElementById('history-list');
    if (!list) return;
    const user = currentUser;
    if (!user) {
        list.innerHTML = '<p class="history-empty">Faça login para ver seus confrontos.</p>';
        return;
    }


    const localHistory = loadLocalHistory();
    const localPairs = Object.values(localHistory.pairs || {})
        .filter(pair => (pair.total || 0) > 0 && pair.players.some(name => playerKey(name) === playerKey(user)));
    const serverPairs = await fetchServerHistory(user);
    const pairs = [...localPairs, ...serverPairs]
        .filter(pair => (pair.total || 0) > 0)
        .sort((a, b) => String(b.lastPlayed || '').localeCompare(String(a.lastPlayed || '')))
        .slice(0, 8);

    if (!pairs.length) {
        list.innerHTML = '<p class="history-empty">Nenhum confronto registrado ainda.</p>';
        return;
    }

    list.innerHTML = pairs.map(pair => {
        const playersList = pair.players || [];
        const userNameInPair = playersList.find(name => playerKey(name) === playerKey(user)) || user;
        const opponent = playersList.find(name => playerKey(name) !== playerKey(user)) || playersList[0] || 'Adversário';
        const userWins = pair.wins?.[userNameInPair] || 0;
        const opponentWins = pair.wins?.[opponent] || 0;
        const total = pair.total || (userWins + opponentWins + (pair.draws || 0));
        const safeUser = escapeHtml(userNameInPair);
        const safeOpponent = escapeHtml(opponent);
        return `
            <div class="history-item">
                <div class="history-names">
                    <strong>${safeUser} x ${safeOpponent}</strong>
                    <span>${total} partida${total === 1 ? '' : 's'}${pair.draws ? `, ${pair.draws} empate${pair.draws === 1 ? '' : 's'}` : ''}</span>
                </div>
                <div class="history-score">${userWins} x ${opponentWins}</div>
            </div>
        `;
    }).join('');
}

async function fetchServerMatches(playerName) {
    try {
        const res = await fetch(`/api/matches?player=${encodeURIComponent(playerName)}`);
        if (!res.ok) return [];
        const data = await res.json();
        return data.matches || [];
    } catch (e) {
        return [];
    }
}

async function renderMatches() {
    const list = document.getElementById('matches-list');
    if (!list) return;
    const user = currentUser;
    if (!user) {
        list.innerHTML = '<p class="history-empty">Faça login para ver replays.</p>';
        return;
    }
    
    const matches = await fetchServerMatches(user);
    if (!matches.length) {
        list.innerHTML = '<p class="history-empty">Nenhuma partida recente gravada.</p>';
        return;
    }
    
    list.innerHTML = matches.map(m => {
        const safeX = escapeHtml(m.players.X);
        const safeO = escapeHtml(m.players.O);
        const resultText = m.winner === 'Empate' ? 'Empate' : `Vencedor: ${escapeHtml(m.winner)}`;
        const movesCount = (m.moves || []).length;
        const btnHtml = movesCount > 0 ? `<button class="btn-replay" onclick='startReplay(${JSON.stringify(m).replace(/'/g, "&apos;")})' style="padding:4px 8px;font-size:12px;background:var(--primary);color:#fff;border-radius:4px;border:none;cursor:pointer">▶️ Ver Replay</button>` : `<span style="font-size:12px;color:var(--text-light)">Sem gravação</span>`;
        return `
            <div class="history-item" style="align-items:center;display:flex;justify-content:space-between;padding-bottom:10px;border-bottom:1px solid var(--border);">
                <div class="history-names">
                    <strong>${safeX} x ${safeO}</strong>
                    <span style="display:block;font-size:12px">${new Date(m.playedAt).toLocaleString()} - ${resultText}</span>
                </div>
                <div>${btnHtml}</div>
            </div>
        `;
    }).join('');
}

// ── Persistência de Sessão ────────────────────────────────────────────────────

function saveSession(code, id, symbol) {
    roomCode = code;
    playerId = id;
    mySymbol = symbol;
    localStorage.setItem('tictactoe2_session', JSON.stringify({ code, id, symbol }));
}

function clearSession() {
    roomCode = null;
    playerId = null;
    mySymbol = null;
    localStorage.removeItem('tictactoe2_session');
}

function tryRestoreSession() {
    try {
        const s = JSON.parse(localStorage.getItem('tictactoe2_session'));
        if (s && s.code && s.id && s.symbol) {
            document.getElementById('input-room-code').value = s.code;
            return s;
        }
    } catch (e) { }
    return null;
}

// ── DOM – Telas ───────────────────────────────────────────────────────────────

const screens = {
    lobby: document.getElementById('screen-lobby'),
    local: document.getElementById('screen-local'),
    ai: document.getElementById('screen-ai'),
    online: document.getElementById('screen-online'),
    game: document.getElementById('screen-game'),
};

function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
}

// ── Persistência de Sessão ────────────────────────────────────────────────────





// ── DOM – Telas ───────────────────────────────────────────────────────────────



// Abas de Login / Cadastro
const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const formLogin = document.getElementById('form-login');
const formRegister = document.getElementById('form-register');
const authErrorMsg = document.getElementById('auth-error-msg');

if (tabLogin && tabRegister && formLogin && formRegister) {
    tabLogin.addEventListener('click', () => {
        tabLogin.classList.add('active');
        tabRegister.classList.remove('active');
        formLogin.classList.remove('hidden');
        formRegister.classList.add('hidden');
        if (authErrorMsg) authErrorMsg.classList.add('hidden');
    });

    tabRegister.addEventListener('click', () => {
        tabRegister.classList.add('active');
        tabLogin.classList.remove('active');
        formRegister.classList.remove('hidden');
        formLogin.classList.add('hidden');
        if (authErrorMsg) authErrorMsg.classList.add('hidden');
    });
}

// Submissao de Formularios de Autenticacao
document.getElementById('btn-login-submit').addEventListener('click', () => {
    const u = document.getElementById('login-username').value.trim();
    const p = document.getElementById('login-password').value;
    if (!u || !p) {
        showAuthError('Por favor, preencha todos os campos.');
        return;
    }
    loginUser(u, p);
});

document.getElementById('login-password').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-login-submit').click();
});
document.getElementById('login-username').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('login-password').focus();
});

document.getElementById('btn-register-submit').addEventListener('click', () => {
    const u = document.getElementById('register-username').value.trim();
    const p = document.getElementById('register-password').value;
    const c = document.getElementById('register-confirm').value;
    if (!u || !p || !c) {
        showAuthError('Por favor, preencha todos os campos.');
        return;
    }
    if (p !== c) {
        showAuthError('As senhas nao conferem.');
        return;
    }
    registerUser(u, p);
});

document.getElementById('register-confirm').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-register-submit').click();
});

document.getElementById('btn-logout').addEventListener('click', () => {
    logoutUser();
});

document.getElementById('btn-refresh-history').addEventListener('click', renderHistory);
document.getElementById('btn-refresh-matches').addEventListener('click', renderMatches);

// ── DOM – Lobby principal ─────────────────────────────────────────────────────

window.addEventListener('load', () => {
    const savedUser = localStorage.getItem(LOGIN_KEY);
    if (savedUser) {
        setCurrentUser(savedUser);
    } else {
        updateAuthUI();
        renderHistory();
        renderMatches();
    }

    // A pedido do usuário, a tela sempre cai no lobby. A partida só retoma por convite ou inserindo código.
    showScreen('lobby');
});

const onlineStatus = document.getElementById('online-status');
const onlineStatusText = document.getElementById('online-status-text');
const roomCodeDisplay = document.getElementById('room-code-display');
const roomCodeValue = document.getElementById('room-code-value');
const onlineError = document.getElementById('online-error');

function resetOnlineUI() {
    onlineStatus.classList.add('hidden');
    roomCodeDisplay.classList.add('hidden');
    onlineError.classList.add('hidden');
    const session = tryRestoreSession();
    document.getElementById('input-room-code').value = session ? session.code : '';

    // Conecta imediatamente para poder assinar os canais de lobby online, salas e conectados.
    connectWS(() => {
        wsSend({ type: 'enterLobby', name: getMyName() });
    });
}

function getMyName() {
    return currentUser ||
        document.getElementById('input-x').value.trim() || 'Jogador';
}

function connectWS(callback) {
    if (socket && socket.readyState === WebSocket.OPEN) { if (callback) callback(); return; }
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${protocol}://${location.host}`);

    socket.addEventListener('open', () => {
        if (callback) callback();
    });
    socket.addEventListener('error', () => showOnlineError('Não foi possível conectar ao servidor.'));
    socket.addEventListener('message', handleServerMessage);
    socket.addEventListener('close', handleSocketClose);
}

function wsSend(data) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(data));
    }
}

function disconnectWS() {
    if (socket) {
        socket.close();
        socket = null;
    }
}

function reconnectToLobby() {
    disconnectWS();
    setTimeout(() => {
        if (currentUser) {
            connectWS(() => {
                wsSend({ type: 'enterLobby', name: getMyName() });
            });
        }
    }, 300);
}

function createRoom() {
    onlineError.classList.add('hidden');
    onlineStatus.classList.remove('hidden');
    onlineStatusText.textContent = 'Criando sala...';

    connectWS(() => {
        wsSend({ type: 'createRoom', name: getMyName() });
    });
}

function joinRoom() {
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    if (code.length < 4) { showOnlineError('Digite o código de 4 caracteres da sala.'); return; }

    const session = tryRestoreSession();
    if (session && session.code === code) {
        rejoinRoom(code, session.id);
        return;
    }
    onlineError.classList.add('hidden');
    onlineStatus.classList.remove('hidden');
    onlineStatusText.textContent = 'Entrando na sala...';

    connectWS(() => {
        wsSend({ type: 'joinRoom', code, name: getMyName() });
    });
}

function joinRoomByCode(code) {
    onlineError.classList.add('hidden');
    onlineStatus.classList.remove('hidden');
    onlineStatusText.textContent = 'Entrando na sala...';
    document.getElementById('input-room-code').value = code;

    connectWS(() => {
        wsSend({ type: 'joinRoom', code, name: getMyName() });
    });
}

function invitePlayer(targetName, btnElement) {
    wsSend({ type: 'invitePlayer', sender: getMyName(), target: targetName });
    if (btnElement) {
        const originalText = btnElement.innerHTML;
        btnElement.innerHTML = '⏳ Enviado...';
        btnElement.disabled = true;
        btnElement.style.opacity = '0.7';
        setTimeout(() => {
            btnElement.innerHTML = originalText;
            btnElement.disabled = false;
            btnElement.style.opacity = '1';
        }, 3000);
    } else {
        showNotification('Convite Enviado', `Convite enviado para ${escapeHtml(targetName)}! Aguardando resposta...`, '📨');
    }
}

document.getElementById('btn-create-room').addEventListener('click', createRoom);
document.getElementById('btn-join-room').addEventListener('click', joinRoom);
document.getElementById('input-room-code').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
document.getElementById('input-room-code').addEventListener('input', e => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});
document.getElementById('btn-copy-code').addEventListener('click', () => {
    navigator.clipboard.writeText(roomCodeValue.textContent).then(() => {
        const btn = document.getElementById('btn-copy-code');
        btn.textContent = '✅ Copiado!';
        setTimeout(() => { btn.textContent = '📋 Copiar Código'; }, 2000);
    });
});

document.getElementById('btn-start-local').addEventListener('click', startLocalGame);
document.getElementById('input-x').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('input-o').focus(); });
document.getElementById('input-o').addEventListener('keydown', e => { if (e.key === 'Enter') startLocalGame(); });
document.getElementById('input-x').addEventListener('input', updateLocalVersusPreview);
document.getElementById('input-o').addEventListener('input', updateLocalVersusPreview);

function startLocalGame() {
    mode = 'local';
    const nameX = cleanPlayerName(document.getElementById('input-x').value, 'Jogador X');
    const nameO = cleanPlayerName(document.getElementById('input-o').value, 'Jogador O');
    players = { X: nameX, O: nameO };
    currentPairScore = getLocalPairScore(nameX, nameO);
    applyPairScoreToScoreboard();
    localMatchRecorded = false;
    startingPlayer = 'X'; // Reinicia: X sempre abre a primeira partida
    clearSession();
    initGame();
}

document.getElementById('btn-mode-local').addEventListener('click', () => {
    if (currentUser) {
        document.getElementById('input-x').value = currentUser;
    }
    updateLocalVersusPreview();
    showScreen('local');
});

document.getElementById('btn-mode-ai').addEventListener('click', () => {
    if (currentUser) {
        document.getElementById('input-ai-player').value = currentUser;
    }
    showScreen('ai');
});

// Lógica de Dificuldade da IA
const aiDiffBtns = document.querySelectorAll('.btn-difficulty');
aiDiffBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        aiDiffBtns.forEach(b => {
            b.style.opacity = '0.4';
            b.style.transform = 'scale(0.95)';
            b.style.boxShadow = 'none';
        });
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1.05)';
        btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
        btn.style.border = '2px solid var(--active-color)';
        btn.style.transition = 'all 0.2s ease';
        
        window.aiDifficultySelected = btn.dataset.level;
        const btnStartAI = document.getElementById('btn-start-ai');
        btnStartAI.style.opacity = '1';
        btnStartAI.style.pointerEvents = 'auto';
    });
});

// Lógica de Velocidade da IA
window.aiSpeedSelected = 0; // Padrão: Rápida
const aiSpeedBtns = document.querySelectorAll('.btn-speed');
aiSpeedBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
        aiSpeedBtns.forEach(b => {
            b.style.opacity = '0.4';
            b.style.transform = 'scale(0.95)';
            b.style.boxShadow = 'none';
        });
        btn.style.opacity = '1';
        btn.style.transform = 'scale(1.05)';
        btn.style.boxShadow = '0 6px 16px rgba(0,0,0,0.2)';
        btn.style.border = '2px solid var(--active-color)';
        btn.style.transition = 'all 0.2s ease';
        
        window.aiSpeedSelected = parseInt(btn.dataset.speed);
    });
});

document.getElementById('btn-start-ai').addEventListener('click', startAIGame);

function startAIGame() {
    mode = 'ai';
    const nameX = cleanPlayerName(document.getElementById('input-ai-player').value, 'Jogador');
    let diffName = 'Fácil';
    if (window.aiDifficultySelected === 'medium') diffName = 'Médio';
    else if (window.aiDifficultySelected === 'hard') diffName = 'Difícil';
    else if (window.aiDifficultySelected === 'super_hard') diffName = 'Impossível';
    const nameO = 'Máquina (' + diffName + ')';
    players = { X: nameX, O: nameO };
    currentPairScore = getLocalPairScore(nameX, nameO);
    applyPairScoreToScoreboard();
    localMatchRecorded = false;
    startingPlayer = 'X'; 
    clearSession();
    initGame();
}

document.getElementById('btn-mode-online').addEventListener('click', () => {
    showScreen('online');
    resetOnlineUI();
});

document.getElementById('btn-back-local').addEventListener('click', () => showScreen('lobby'));
document.getElementById('btn-back-ai').addEventListener('click', () => showScreen('lobby'));
document.getElementById('btn-back-online').addEventListener('click', () => {
    // Mantém a conexão para continuar recebendo mensagens/convites
    showScreen('lobby');
});

function rejoinRoom(code, pid) {
    onlineError.classList.add('hidden');
    onlineStatus.classList.remove('hidden');
    onlineStatusText.textContent = 'Reconectando à sala...';

    connectWS(() => {
        wsSend({ type: 'rejoinRoom', code, playerId: pid });
    });
}

function showOnlineError(msg) {
    onlineStatus.classList.add('hidden');
    onlineError.textContent = msg;
    onlineError.classList.remove('hidden');
}

function handleServerMessage(event) {
    const msg = JSON.parse(event.data);
    switch (msg.type) {

        case 'onlineLobbyState': {
            const roomsList = document.getElementById('active-rooms-list');
            if (roomsList) {
                if (msg.rooms.length === 0) {
                    roomsList.innerHTML = '<p class="empty-list-msg-new">Nenhuma sala criada no momento.</p>';
                } else {
                    roomsList.innerHTML = msg.rooms.map(room => {
                        const countText = `${room.playersCount}/2 jogando`;
                        const statusBadge = room.started ? '<span class="lobby-badge text-glow-o" style="background:#555">Em Jogo</span>' : '<span class="lobby-badge text-glow-x" style="background:var(--green)">Aberta</span>';
                        const actionButton = (room.playersCount < 2 && !room.started) 
                            ? `<button class="btn-lobby-join" onclick="joinRoomByCode('${room.code}')">Entrar</button>`
                            : `<button class="btn-lobby-join" disabled style="opacity:0.5; cursor:not-allowed">Cheia</button>`;
                        
                        return `
                            <div class="lobby-room-item">
                                <div class="room-info">
                                    <span class="room-code-tag">${room.code}</span>
                                    <span class="room-details">Criador: <strong>${escapeHtml(room.creator)}</strong> | ${countText}</span>
                                </div>
                                <div class="room-actions">
                                    ${statusBadge}
                                    ${actionButton}
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }

            const usersList = document.getElementById('active-users-list');
            if (usersList) {
                const myName = getMyName();
                const filteredUsers = msg.users.filter(u => u !== myName);
                if (filteredUsers.length === 0) {
                    usersList.innerHTML = '<p class="empty-list-msg-new">Nenhum outro jogador online.</p>';
                } else {
                    usersList.innerHTML = filteredUsers.map(user => {
                        return `
                            <div class="lobby-user-item">
                                <div class="user-info">
                                    <span class="user-avatar-small">👤</span>
                                    <span class="user-name-small">${escapeHtml(user)}</span>
                                </div>
                                <div class="user-actions">
                                    <button class="btn-lobby-invite" onclick="invitePlayer('${escapeHtml(user)}', this)">🎮 Convidar</button>
                                    <button class="btn-lobby-invite" style="background:var(--active-color);" onclick="openPrivateChat('${escapeHtml(user)}')">💬 Chat</button>
                                </div>
                            </div>
                        `;
                    }).join('');
                }
            }
            break;
        }
        case 'privateMessage': {
            const sender = msg.sender;
            if (!privateChatSession[sender]) privateChatSession[sender] = [];
            privateChatSession[sender].push({ sender, text: msg.text, read: false });
            
            // Se o painel não está aberto OU não estamos na aba dessa pessoa, incrementa não lidas
            const chatPanel = document.getElementById('private-chat-panel');
            const isPanelOpen = chatPanel && !chatPanel.classList.contains('hidden');
            
            if (!isPanelOpen || currentChatTarget !== sender) {
                unreadMessagesCount++;
                updateChatBadge();
            } else {
                // Se o painel já está aberto E estamos na aba dessa pessoa
                privateChatSession[sender].forEach(m => m.read = true);
                renderChatMessages();
            }

            if (!isPanelOpen) {
                const chatToggleBtn = document.getElementById('private-chat-toggle');
                if (chatToggleBtn) chatToggleBtn.classList.remove('hidden');
            }
            
            // Sempre que chega uma mensagem, renderiza as abas (se aberto) pra atualizar a bolinha
            if (isPanelOpen) {
                renderChatTabs();
            }
            
            // Se for a primeira mensagem e não temos aba, e não estamos conversando com ninguém, foca nela
            if (isPanelOpen && !currentChatTarget) {
                currentChatTarget = sender;
                renderChatTabs();
                renderChatMessages();
            }
            
            break;
        }

        case 'matchInvite': {
            const inviteMsg = document.getElementById('match-invite-msg');
            if (inviteMsg) {
                inviteMsg.innerHTML = `O jogador <strong>${escapeHtml(msg.sender)}</strong> está te convidando para uma partida.`;
            }
            const overlayInvite = document.getElementById('overlay-match-invite');
            if (overlayInvite) {
                overlayInvite.classList.remove('hidden');
                window.currentInviteSender = msg.sender;
            }
            break;
        }

        case 'inviteDeclined': {
            showNotification('Convite Recusado', `O jogador <strong>${escapeHtml(msg.responder)}</strong> recusou o seu convite.`, '❌');
            break;
        }

        case 'inviteAcceptedRedirect': {
            saveSession(msg.code, msg.playerId, msg.symbol);
            roomCode = msg.code;
            mySymbol = msg.symbol;
            rejoinRoom(msg.code, msg.playerId);
            break;
        }

        case 'roomCreated':
            saveSession(msg.code, msg.playerId, 'X');
            roomCode = msg.code;
            roomCodeValue.textContent = msg.code;
            roomCodeDisplay.classList.remove('hidden');
            onlineStatusText.textContent = 'Aguardando o oponente...';
            mySymbol = 'X';
            mode = 'online';
            players = {
                X: getMyName(),
                O: 'Aguardando...'
            };
            currentPairScore = { X: 0, O: 0, draws: 0, total: 0 };
            applyPairScoreToScoreboard();
            state = msg.state || createInitialGameState('X');
            showScreen('game');
            buildBoard();
            renderAll();
            updateStatus(`Sala criada! Aguardando oponente... Código: ${msg.code}`);
            document.getElementById('game-mode-badge').textContent = '🌐 ' + msg.code;
            break;

        case 'gameStart':
            if (msg.playerId) {
                saveSession(roomCode || document.getElementById('input-room-code').value.trim().toUpperCase(), msg.playerId, msg.symbol);
            }
            mySymbol = msg.symbol;
            mode = 'online';
            players = {
                X: msg.symbol === 'X' ? msg.myName : msg.opponentName,
                O: msg.symbol === 'O' ? msg.myName : msg.opponentName,
            };
            currentPairScore = msg.headToHead || { X: 0, O: 0, draws: 0, total: 0 };
            applyPairScoreToScoreboard();
            state = msg.state;
            
            const btnChat = document.getElementById('btn-chat-opponent');
            if (btnChat) btnChat.classList.remove('hidden');
            
            // Esconde o placar estendido
            const mr1 = document.getElementById('match-record');
            if (mr1) mr1.classList.add('hidden');
            
            showScreen('game');
            buildBoard();
            if (state.gameOver) {
                renderAll();
                handleGameOver(state.winner, true); // true = skip animation
            } else {
                renderAll();
                updateTurnStatus();
            }
            document.getElementById('game-mode-badge').textContent = '🌐 ' + (roomCode || msg.code || 'Online');
            break;

        case 'rejoined':
mySymbol = msg.symbol;
mode = 'online';
players = {
    X: msg.symbol === 'X' ? msg.myName : msg.opponentName,
    O: msg.symbol === 'O' ? msg.myName : msg.opponentName,
};
currentPairScore = msg.headToHead || { X: 0, O: 0, draws: 0, total: 0 };
applyPairScoreToScoreboard();
state = msg.state;

const btnChatRejoin = document.getElementById('btn-chat-opponent');
if (btnChatRejoin) btnChatRejoin.classList.remove('hidden');

// Esconde o placar estendido
const mr2 = document.getElementById('match-record');
if (mr2) mr2.classList.add('hidden');

showScreen('game');
document.getElementById('overlay-left').classList.add('hidden');
document.getElementById('overlay').classList.add('hidden');
if (document.getElementById('overlay-draw-request')) document.getElementById('overlay-draw-request').classList.add('hidden');

// Garante que o tabuleiro está limpo e renderizado após F5
buildBoard();

if (state.gameOver) {
    renderAll();
    handleGameOver(state.winner, true); // true = skip animation on rejoin
} else {
    renderAll();
    updateTurnStatus();
}
document.getElementById('game-mode-badge').textContent = '🌐 ' + (roomCode || 'Online');
break;

        case 'rejoinFailed':
            clearSession();
            document.getElementById('input-room-code').value = '';
            showScreen('lobby');
            break;

        case 'opponentRejoined':
document.getElementById('overlay-left').classList.add('hidden');
if (disconnectInterval) { clearInterval(disconnectInterval); disconnectInterval = null; }
break;

        case 'opponentDisconnectedWait':
            document.getElementById('overlay').classList.add('hidden');
            if (document.getElementById('overlay-restart-request')) document.getElementById('overlay-restart-request').classList.add('hidden');
            
            const overlayLeftMsg = document.getElementById('overlay-left-msg');
            let timeLeft = Math.floor(msg.timeoutMs / 1000);
            overlayLeftMsg.innerHTML = `Seu adversário desconectou. Aguardando retorno em <strong id="disconnect-timer">${timeLeft}</strong>s...`;
            document.getElementById('overlay-left').classList.remove('hidden');
            
            // Se eu estava aguardando um empate, o pedido é cancelado pois o modal do outro sumiu
            const btnSuggest = document.getElementById('btn-suggest-draw');
            if (btnSuggest) {
                btnSuggest.innerHTML = `🤝 Sugerir Empate`;
                btnSuggest.disabled = false;
            }
            
            if (disconnectInterval) clearInterval(disconnectInterval);
            disconnectInterval = setInterval(() => {
                timeLeft--;
                if (timeLeft <= 0) {
                    clearInterval(disconnectInterval);
                    disconnectInterval = null;
                } else {
                    const timerEl = document.getElementById('disconnect-timer');
                    if (timerEl) timerEl.textContent = timeLeft;
                }
            }, 1000);
            break;

        case 'matchPausedRedirect':
            if (disconnectInterval) { clearInterval(disconnectInterval); disconnectInterval = null; }
            document.getElementById('overlay-left').classList.add('hidden');
            disconnectWS();
            updateStatus('A partida foi pausada e salva.');
            showScreen('lobby');
            break;

        case 'state':
            state = msg.state;
            if (msg.headToHead) {
                currentPairScore = msg.headToHead;
                applyPairScoreToScoreboard();
                renderHistory();
            }
            if (state.gameOver) {
                renderAll();
                handleGameOver(state.winner);
            } else {
                renderAll();
                updateTurnStatus();
            }
            break;

        case 'drawRequested':
            document.getElementById('overlay-draw-request').classList.remove('hidden');
            break;

        case 'drawDeclined':
            const btn = document.getElementById('btn-suggest-draw');
            btn.innerHTML = `🤝 Sugerir Empate`;
            btn.disabled = false;
            updateStatus("O adversário recusou o empate.");
            break;

        case 'emote':
            const opSymbol = mySymbol === 'X' ? 'O' : 'X';
            showEmote(opSymbol, msg.content);
            break;

        case 'drawAcceptedRedirect':
            document.getElementById('overlay-draw-request').classList.add('hidden');
            if (document.getElementById('overlay-surrender')) document.getElementById('overlay-surrender').classList.add('hidden');
            disconnectWS();
            renderHistory();
            showScreen('lobby');
            break;

        case 'opponentLeft':
document.getElementById('overlay').classList.add('hidden');
if (document.getElementById('overlay-restart-request')) document.getElementById('overlay-restart-request').classList.add('hidden');
const oldMsg = document.getElementById('overlay-left-msg');
if (oldMsg) oldMsg.innerHTML = 'Seu adversário desconectou da partida e a sala foi encerrada.';
document.getElementById('overlay-left').classList.remove('hidden');
break;

        case 'error':
showOnlineError(msg.msg);
break;
    }
}

function handleSocketClose() {
    if (screens.game.classList.contains('hidden') || mode !== 'online') return;
    // Tenta auto-reconectar se o cliente cair (ex: wifi falhar uns segundos)
    console.log('Conexão perdida. Status local mantido. Atualize a página e clique no lobby para reconectar.');
}

// ── DOM – Jogo ────────────────────────────────────────────────────────────────

const mainBoard = document.getElementById('main-board');
const statusMsg = document.getElementById('status-msg');
const turnIndicator = document.getElementById('turn-indicator');
const turnText = document.getElementById('turn-text');
const cardX = document.getElementById('card-x');
const cardO = document.getElementById('card-o');
const scoreXEl = document.getElementById('score-x');
const scoreOEl = document.getElementById('score-o');
const overlay = document.getElementById('overlay');
const overlayLeft = document.getElementById('overlay-left');
const overlayDrawRequest = document.getElementById('overlay-draw-request');

document.getElementById('btn-replay-next').addEventListener('click', () => {
    if (currentReplayIndex < currentReplayMoves.length) {
        const move = currentReplayMoves[currentReplayIndex];
        applyMove(move.boardIdx, move.cellIdx);
        currentReplayIndex++;
        updateReplayUI();
    }
});
document.getElementById('btn-replay-prev').addEventListener('click', () => {
    if (currentReplayIndex > 0) {
        currentReplayIndex--;
        const startingSymbol = currentReplayMoves.length > 0 ? currentReplayMoves[0].player : 'X';
        state = createInitialState(startingSymbol);
        for (let i = 0; i < currentReplayIndex; i++) {
            const m = currentReplayMoves[i];
            state.cells[m.boardIdx][m.cellIdx] = m.player;
            const miniResult = checkWinner(state.cells[m.boardIdx]);
            if (miniResult) state.macroBoard[m.boardIdx] = typeof miniResult === 'object' ? miniResult.winner : miniResult;
            const macroResult = checkWinner(state.macroBoard);
            if (macroResult) {
                state.gameOver = true;
                if (typeof macroResult === 'object') {
                    state.winner = macroResult.winner;
                    state.winLine = macroResult.line;
                } else {
                    state.winner = 'draw';
                }
            } else {
                const nextBoard = m.cellIdx;
                state.activeBoard = (state.macroBoard[nextBoard] || state.cells[nextBoard].every(c => c !== null)) ? null : nextBoard;
                if (state.macroBoard.every(c => c !== null)) {
                    state.gameOver = true;
                    state.winner = 'draw';
                } else {
                    state.currentPlayer = m.player === 'X' ? 'O' : 'X';
                }
            }
        }
        renderAll();
        updateTurnStatus();
        updateReplayUI();
    }
});

function updateReplayUI() {
    document.getElementById('replay-step-text').textContent = `${currentReplayIndex} / ${currentReplayMoves.length}`;
    document.getElementById('btn-replay-prev').disabled = currentReplayIndex === 0;
    document.getElementById('btn-replay-next').disabled = currentReplayIndex === currentReplayMoves.length;
}

window.startReplay = function(match) {
    mode = 'replay';
    currentReplayMoves = match.moves || [];
    currentReplayIndex = 0;
    const startingSymbol = currentReplayMoves.length > 0 ? currentReplayMoves[0].player : 'X';
    state = createInitialState(startingSymbol);
    
    players = { X: match.players.X, O: match.players.O };
    document.getElementById('name-x-display').textContent = players.X;
    document.getElementById('name-x-display').textContent = match.players.X;
    document.getElementById('name-o-display').textContent = match.players.O;
    document.getElementById('game-mode-badge').textContent = '📽️ Replay';
    const mr = document.getElementById('match-record');
    mr.textContent = `Revisando partida de ${new Date(match.playedAt).toLocaleDateString()}`;
    mr.classList.remove('hidden');
    
    document.getElementById('game-controls').classList.add('hidden');
    document.getElementById('replay-controls').classList.remove('hidden');
    
    showScreen('game');
    buildBoard();
    renderAll();
    updateReplayUI();
    
    const turnText = document.getElementById('turn-text');
    turnText.innerHTML = `Vez de <strong>${state.currentPlayer}</strong>`;
}

document.getElementById('btn-back-game').addEventListener('click', () => {
    if (mode === 'replay') {
        renderMatches();
        showScreen('lobby');
    } else if (mode === 'online' && !state.gameOver) {
        document.getElementById('overlay-surrender').classList.remove('hidden');
    } else {
        reconnectToLobby();
        renderHistory();
        showScreen('lobby');
    }
});
document.getElementById('btn-suggest-draw').addEventListener('click', () => {
    if (mode === 'online' && !state.gameOver) {
        const btn = document.getElementById('btn-suggest-draw');
        btn.innerHTML = `<span class="status-spinner" style="width:14px;height:14px;border-top-color:#fff;margin-right:6px"></span> Aguardando...`;
        btn.disabled = true;
        wsSend({ type: 'suggestDraw' });
        updateStatus("Aguardando resposta ao empate...");
    }
});

// ── Reações / Emotes ──
const emotePanel = document.getElementById('emote-panel');
document.getElementById('btn-show-emotes').addEventListener('click', () => {
    if (mode === 'online' && !state.gameOver) {
        emotePanel.classList.toggle('hidden');
    }
});
document.querySelectorAll('.emote-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const text = e.target.dataset.emote;
        if (!text) return;
        emotePanel.classList.add('hidden');
        if (mode === 'online') {
            wsSend({ type: 'emote', content: text });
        }
        showEmote(mySymbol, text);
    });
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('#emote-panel') && !e.target.closest('#btn-show-emotes')) {
        emotePanel.classList.add('hidden');
    }
});

const emoteTimers = { X: null, O: null };
function showEmote(symbol, text) {
    const bubble = document.getElementById(symbol === 'X' ? 'emote-bubble-x' : 'emote-bubble-o');
    if (!bubble) return;
    
    bubble.textContent = text;
    bubble.classList.add('show');
    
    if (emoteTimers[symbol]) clearTimeout(emoteTimers[symbol]);
    emoteTimers[symbol] = setTimeout(() => {
        bubble.classList.remove('show');
    }, 3000);
}
document.getElementById('btn-lobby').addEventListener('click', () => {
    overlay.classList.add('hidden');
    reconnectToLobby();
    renderHistory();
    showScreen('lobby');
});
document.getElementById('btn-lobby-left').addEventListener('click', () => {
    overlayLeft.classList.add('hidden');
    reconnectToLobby();
    renderHistory();
    showScreen('lobby');
});

// Respostas ao pedido de empate
document.getElementById('btn-accept-draw').addEventListener('click', () => {
    document.getElementById('overlay-draw-request').classList.add('hidden');
    wsSend({ type: 'drawResponse', accepted: true });
});
document.getElementById('btn-decline-draw').addEventListener('click', () => {
    document.getElementById('overlay-draw-request').classList.add('hidden');
    wsSend({ type: 'drawResponse', accepted: false });
});

// Desistência
document.getElementById('btn-confirm-surrender').addEventListener('click', () => {
    document.getElementById('overlay-surrender').classList.add('hidden');
    wsSend({ type: 'surrender' });
    
    // Desconecta e volta imediatamente, o servidor se encarrega de dar o ponto e fechar a sala
    reconnectToLobby();
    renderHistory();
    showScreen('lobby');
});
document.getElementById('btn-cancel-surrender').addEventListener('click', () => {
    document.getElementById('overlay-surrender').classList.add('hidden');
});

// Respostas ao convite de partida
document.getElementById('btn-accept-invite').addEventListener('click', () => {
    document.getElementById('overlay-match-invite').classList.add('hidden');
    if (window.currentInviteSender) {
        wsSend({ type: 'inviteResponse', sender: window.currentInviteSender, accepted: true });
        window.currentInviteSender = null;
    }
});
document.getElementById('btn-decline-invite').addEventListener('click', () => {
    document.getElementById('overlay-match-invite').classList.add('hidden');
    if (window.currentInviteSender) {
        wsSend({ type: 'inviteResponse', sender: window.currentInviteSender, accepted: false });
        window.currentInviteSender = null;
    }
});

// ── Jogo local – inicialização ────────────────────────────────────────────────

function initGame() {
    document.getElementById('game-controls').classList.remove('hidden');
    document.getElementById('replay-controls').classList.add('hidden');
    
    state = createInitialState(startingPlayer);
    localMatchRecorded = false;
    applyPairScoreToScoreboard();
    document.getElementById('name-x-display').textContent = players.X;
    document.getElementById('name-o-display').textContent = players.O;
    document.getElementById('game-mode-badge').textContent = mode === 'ai' ? '🤖 Contra Máquina' : '👥 Local';
    
    // Esconder placar textual repetitivo, mostrar apenas as cartas
    const mr = document.getElementById('match-record');
    if (mr) mr.classList.add('hidden');
    
    showScreen('game');
    buildBoard();
    renderAll();
    updateStatus(`${players[startingPlayer]} começa! Escolha qualquer tabuleiro.`);
    
    if (mode === 'ai' && startingPlayer === 'O') {
        setTimeout(playAITurn, 600);
    }
}

// ── Renderização ──────────────────────────────────────────────────────────────

function buildBoard() {
    mainBoard.innerHTML = '';
    for (let bi = 0; bi < 9; bi++) {
        const mb = document.createElement('div');
        mb.classList.add('mini-board');
        mb.dataset.board = bi;
        for (let ci = 0; ci < 9; ci++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.board = bi;
            cell.dataset.cell = ci;
            cell.addEventListener('click', handleCellClick);
            mb.appendChild(cell);
        }
        mainBoard.appendChild(mb);
    }
}

function renderAll() {
    document.getElementById('name-x-display').textContent = players.X;
    document.getElementById('name-o-display').textContent = players.O;
    updateMatchRecord();
    renderBoard();
    updateInfoBar();
}

function renderBoard() {
    mainBoard.querySelectorAll('.mini-board').forEach((mb, bi) => {
        const existingWin = mb.querySelector('.mini-won-symbol');
        if (existingWin && !state.macroBoard[bi]) {
            existingWin.remove();
        }
        mb.classList.remove('active', 'won-x', 'won-o', 'draw-board', 'disabled', 'macro-winner');

        const ms = state.macroBoard[bi];
        if (ms === 'X') { mb.classList.add('won-x'); if (!existingWin) addMiniWinSymbol(mb, 'X'); }
        else if (ms === 'O') { mb.classList.add('won-o'); if (!existingWin) addMiniWinSymbol(mb, 'O'); }
        else if (ms === 'draw') { mb.classList.add('draw-board'); if (!existingWin) addMiniWinSymbol(mb, 'draw'); }
        else {
            const active = !state.gameOver && (state.activeBoard === null || state.activeBoard === bi);
            mb.classList.toggle('active', active);
            mb.classList.toggle('disabled', !active);
        }

        mb.querySelectorAll('.cell').forEach((cellEl, ci) => {
            const val = state.cells[bi][ci];
            cellEl.classList.remove('x-cell', 'o-cell', 'taken', 'not-my-turn', 'winner');
            cellEl.innerHTML = '';
            if (val) {
                const mark = document.createElement('span');
                mark.classList.add('mark');
                mark.textContent = val;
                cellEl.appendChild(mark);
                cellEl.classList.add('taken', val === 'X' ? 'x-cell' : 'o-cell');
            }

            if (mode === 'online' && !val && state.currentPlayer !== mySymbol) {
                cellEl.classList.add('not-my-turn');
            }
        });
    });
}

function addMiniWinSymbol(mb, winner) {
    const sym = document.createElement('div');
    sym.classList.add('mini-won-symbol');
    sym.classList.add(winner === 'X' ? 'x-win' : winner === 'O' ? 'o-win' : 'draw-win');
    sym.textContent = winner === 'draw' ? '=' : winner;
    mb.appendChild(sym);
}

function updateInfoBar() {
    const p = state.currentPlayer;
    const name = players[p];
    turnText.innerHTML = `Vez de <strong>${name}</strong>`;
    turnIndicator.className = 'turn-indicator ' + (p === 'X' ? 'turn-x' : 'turn-o');
    cardX.classList.toggle('active-card', p === 'X' && !state.gameOver);
    cardO.classList.toggle('active-card', p === 'O' && !state.gameOver);
    scoreXEl.textContent = scoreX;
    scoreOEl.textContent = scoreO;
}

function updateStatus(msg) { statusMsg.textContent = msg; }

function updateTurnStatus() {
    if (mode === 'online') {
        const isMyTurn = state.currentPlayer === mySymbol;
        const sb = document.getElementById('status-bar');
        sb.classList.toggle('my-turn', isMyTurn);
        sb.classList.toggle('enemy-turn', !isMyTurn);
        if (isMyTurn) {
            updateStatus(state.activeBoard !== null
                ? `Sua vez! Jogue no tabuleiro ${state.activeBoard + 1}.`
                : `Sua vez! Escolha qualquer tabuleiro disponível.`);
        } else {
            updateStatus(`Aguardando ${players[state.currentPlayer]} jogar...`);
        }
    } else {
        const name = players[state.currentPlayer];
        updateStatus(state.activeBoard !== null
            ? `${name} deve jogar no tabuleiro ${state.activeBoard + 1}.`
            : `${name} — escolha qualquer tabuleiro disponível!`);
    }
    updateInfoBar();
}

// ── Jogada ────────────────────────────────────────────────────────────────────

function handleCellClick(e) {
    if (state.gameOver || mode === 'replay') return;
    if (mode === 'online' && state.currentPlayer !== mySymbol) return;
    if (mode === 'ai' && state.currentPlayer === 'O') return;

    const bi = parseInt(e.currentTarget.dataset.board);
    const ci = parseInt(e.currentTarget.dataset.cell);

    if (state.macroBoard[bi]) return;
    if (state.activeBoard !== null && state.activeBoard !== bi) return;
    if (state.cells[bi][ci]) return;

    ripple(e.currentTarget);

    if (mode === 'online') {
        wsSend({ type: 'move', boardIdx: bi, cellIdx: ci });
        return;
    }

    applyMove(bi, ci);
}

function applyMove(bi, ci) {
    const sym = state.currentPlayer;
    state.cells[bi][ci] = sym;

    const miniResult = checkWinner(state.cells[bi]);
    if (miniResult) state.macroBoard[bi] = typeof miniResult === 'object' ? miniResult.winner : miniResult;

    const macroResult = checkWinner(state.macroBoard);
    if (macroResult) {
        state.gameOver = true;
        if (typeof macroResult === 'object') {
            state.winner = macroResult.winner;
            state.winLine = macroResult.line;
        } else {
            state.winner = 'draw';
        }
        renderAll();
        handleGameOver(state.winner);
        return;
    }

    const nextBoard = ci;
    state.activeBoard = (state.macroBoard[nextBoard] || state.cells[nextBoard].every(c => c !== null))
        ? null : nextBoard;

    if (state.macroBoard.every(c => c !== null)) {
        state.gameOver = true;
        state.winner = 'draw';
        renderAll();
        handleGameOver('draw');
        return;
    }

    state.currentPlayer = sym === 'X' ? 'O' : 'X';
    renderAll();
    updateTurnStatus();

    if (mode === 'ai' && !state.gameOver && state.currentPlayer === 'O') {
        setTimeout(playAITurn, 600);
    }
}

// ── Verificadores ─────────────────────────────────────────────────────────────

// Retorna null, 'draw', ou { winner, line }
function checkWinner(board) {
    for (const [a, b, c] of WIN_LINES) {
        if (board[a] && board[a] !== 'draw' && board[a] === board[b] && board[a] === board[c])
            return { winner: board[a], line: [a, b, c] };
    }
    if (board.every(cell => cell !== null)) return 'draw';
    return null;
}

// ── Fim de jogo ───────────────────────────────────────────────────────────────

function handleGameOver(result, skipAnimation = false) {
    state.gameOver = true;

    cardX.classList.remove('active-card');
    cardO.classList.remove('active-card');

    // Adiciona a animação de vitória no tabuleiro se houver winLine
    let animDuration = 0;
    if (!skipAnimation && state.winLine) {
        animDuration = 1800; // 1.8 segundos contemplando a animação antes do overlay
        state.winLine.forEach(bi => {
            const mb = mainBoard.querySelector(`.mini-board[data-board="${bi}"]`);
            if (mb) mb.classList.add('macro-winner');
        });
    }

    // Espera a animação (se houver) para mostrar o overlay final
    setTimeout(() => {
        const overlaySymbolEl = document.getElementById('overlay-symbol');
        const overlayTitleEl = document.getElementById('overlay-title');
        const overlayMsgEl = document.getElementById('overlay-msg');

        if (result === 'draw') {
            overlaySymbolEl.textContent = '🤝';
            overlaySymbolEl.className = 'overlay-symbol draw';
            overlayTitleEl.textContent = 'Empate!';
            overlayMsgEl.textContent = 'Nenhum jogador conquistou 3 tabuleiros em linha.';
            updateStatus('Empate! Nenhum vencedor desta vez.');
            turnText.innerHTML = 'Empate!';
        } else {
            const winnerName = players[result];
            overlaySymbolEl.textContent = result;
            overlaySymbolEl.className = 'overlay-symbol ' + (result === 'X' ? 'x-win' : 'o-win');
            overlayTitleEl.textContent = `${winnerName} Venceu! 🏆`;
            overlayMsgEl.textContent = `Parabéns, ${winnerName}! Você dominou o Super Jogo da Velha!`;
            updateStatus(`🏆 ${winnerName} venceu!`);
            turnText.innerHTML = `<strong>${winnerName}</strong> Venceu!`;
        }

        if ((mode === 'local' || mode === 'ai') && !localMatchRecorded) {
            localMatchRecorded = true;
            recordLocalMatch(result);
        } else {
            applyPairScoreToScoreboard();
        }

        scoreXEl.textContent = scoreX;
        scoreOEl.textContent = scoreO;

        overlay.classList.remove('hidden');
    }, animDuration);
}

// ── Utils ─────────────────────────────────────────────────────────────────────

function ripple(el) {
    el.classList.remove('ripple');
    void el.offsetWidth;
    el.classList.add('ripple');
}

// ── Inteligência Artificial (Modo Computador) ─────────────────────────────────

function getValidMoves(st) {
    let moves = [];
    let boards = st.activeBoard !== null ? [st.activeBoard] : [0, 1, 2, 3, 4, 5, 6, 7, 8];
    for (let b of boards) {
        if (!st.macroBoard[b]) {
            for (let c = 0; c < 9; c++) {
                if (!st.cells[b][c]) {
                    moves.push({ b, c });
                }
            }
        }
    }
    return moves;
}

function playAITurn() {
    if (state.gameOver || mode !== 'ai') return;
    let diff = window.aiDifficultySelected || 'easy';
    let move = calculateAIMove(state, diff);
    if (move) {
        if (window.aiSpeedSelected > 0) {
            setTimeout(() => applyMove(move.b, move.c), window.aiSpeedSelected);
        } else {
            applyMove(move.b, move.c);
        }
    }
}

function calculateAIMove(st, difficulty) {
    let moves = getValidMoves(st);
    if (moves.length === 0) return null;

    if (difficulty === 'easy') {
        // Fácil: 50% chance de olhar 1 jogada à frente (como era o médio antigamente), 50% de jogar aleatório
        if (Math.random() < 0.5) {
            for (let m of moves) {
                st.cells[m.b][m.c] = 'O';
                let win = checkWinner(st.cells[m.b]);
                st.cells[m.b][m.c] = null;
                if (win) return m;
            }
            for (let m of moves) {
                st.cells[m.b][m.c] = 'X';
                let win = checkWinner(st.cells[m.b]);
                st.cells[m.b][m.c] = null;
                if (win) return m;
            }
        }
        return moves[Math.floor(Math.random() * moves.length)];
    }

    let depth = 2; // Medium default depth

    if (difficulty === 'hard') {
        depth = 4;
        if (moves.length > 30) depth = 3; 
    } else if (difficulty === 'super_hard') {
        depth = 5;
        if (moves.length > 35) depth = 4;
        if (moves.length < 12) depth = 6;
    }

    let bestScore = -Infinity;
    let bestMove = moves[0];
    
    // Otimização: Aleatorizar ordem dos movimentos para evitar previsibilidade quando as pontuações são iguais
    moves.sort(() => Math.random() - 0.5);

    for (let m of moves) {
        let clonedState = cloneState(st);
        simulateMove(clonedState, m.b, m.c, 'O');
        let score = minimax(clonedState, depth, false, -Infinity, Infinity);
        if (score > bestScore) {
            bestScore = score;
            bestMove = m;
        }
    }
    return bestMove;
}

function cloneState(st) {
    return {
        cells: st.cells.map(arr => [...arr]),
        macroBoard: [...st.macroBoard],
        currentPlayer: st.currentPlayer,
        activeBoard: st.activeBoard,
        gameOver: st.gameOver,
        winner: st.winner,
        winLine: st.winLine
    };
}

function simulateMove(st, bi, ci, player) {
    st.cells[bi][ci] = player;
    let mini = checkWinner(st.cells[bi]);
    if (mini) st.macroBoard[bi] = typeof mini === 'object' ? mini.winner : mini;

    let macro = checkWinner(st.macroBoard);
    if (macro) {
        st.gameOver = true;
        st.winner = typeof macro === 'object' ? macro.winner : 'draw';
    } else {
        st.activeBoard = (st.macroBoard[ci] || st.cells[ci].every(c => c !== null)) ? null : ci;
        if (st.macroBoard.every(c => c !== null)) {
            st.gameOver = true;
            st.winner = 'draw';
        } else {
            st.currentPlayer = player === 'X' ? 'O' : 'X';
        }
    }
}

function evaluateState(st) {
    if (st.gameOver) {
        if (st.winner === 'O') return 10000;
        if (st.winner === 'X') return -10000;
        return 0;
    }
    let score = 0;
    for (let i = 0; i < 9; i++) {
        if (st.macroBoard[i] === 'O') score += 100;
        else if (st.macroBoard[i] === 'X') score -= 100;
    }
    for (let b = 0; b < 9; b++) {
        if (st.macroBoard[b]) continue;
        for (let c = 0; c < 9; c++) {
            if (st.cells[b][c] === 'O') score += (c === 4 ? 3 : 1);
            else if (st.cells[b][c] === 'X') score -= (c === 4 ? 3 : 1);
        }
    }
    return score;
}

function minimax(st, depth, isMaximizing, alpha, beta) {
    if (depth === 0 || st.gameOver) {
        return evaluateState(st);
    }
    let moves = getValidMoves(st);
    if (moves.length === 0) return evaluateState(st);

    if (isMaximizing) {
        let maxEval = -Infinity;
        for (let m of moves) {
            let cloned = cloneState(st);
            simulateMove(cloned, m.b, m.c, 'O');
            let ev = minimax(cloned, depth - 1, false, alpha, beta);
            maxEval = Math.max(maxEval, ev);
            alpha = Math.max(alpha, ev);
            if (beta <= alpha) break;
        }
        return maxEval;
    } else {
        let minEval = Infinity;
        for (let m of moves) {
            let cloned = cloneState(st);
            simulateMove(cloned, m.b, m.c, 'X');
            let ev = minimax(cloned, depth - 1, true, alpha, beta);
            minEval = Math.min(minEval, ev);
            beta = Math.min(beta, ev);
            if (beta <= alpha) break;
        }
        return minEval;
    }
}

function showNotification(title, msg, symbol = 'ℹ️') {
    const overlay = document.getElementById('overlay-notification');
    const titleEl = document.getElementById('notification-title');
    const msgEl = document.getElementById('notification-msg');
    const symbolEl = document.getElementById('notification-symbol');
    
    if (overlay && titleEl && msgEl && symbolEl) {
        titleEl.textContent = title;
        msgEl.innerHTML = msg;
        symbolEl.textContent = symbol;
        overlay.classList.remove('hidden');
    } else {
        alert(`${title}: ${msg}`);
    }
}

const btnCloseNotification = document.getElementById('btn-close-notification');
if (btnCloseNotification) {
    btnCloseNotification.addEventListener('click', () => {
        document.getElementById('overlay-notification').classList.add('hidden');
    });
}

// ── Init ──────────────────────────────────────────────────────────────────────

// ── Chat Privado ──────────────────────────────────────────────────────────────
let currentChatTarget = null;
const privateChatSession = {}; // { username: [{ sender: 'A', text: 'oi' }] }

const chatToggleBtn = document.getElementById('private-chat-toggle');
const chatPanel = document.getElementById('private-chat-panel');
const chatCloseBtn = document.getElementById('btn-close-chat');
const chatTargetName = document.getElementById('chat-target-name');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('btn-send-chat');
const chatBadge = document.getElementById('chat-badge');

let unreadMessagesCount = 0;

function updateChatBadge() {
    if (chatBadge) {
        if (unreadMessagesCount > 0) {
            chatBadge.textContent = unreadMessagesCount > 9 ? '9+' : unreadMessagesCount;
            chatBadge.classList.remove('hidden');
        } else {
            chatBadge.classList.add('hidden');
        }
    }
}

function renderChatTabs() {
    const tabsContainer = document.getElementById('chat-tabs-container');
    if (!tabsContainer) return;
    
    const targets = Object.keys(privateChatSession);
    if (targets.length === 0) {
        tabsContainer.innerHTML = '';
        return;
    }
    
    tabsContainer.innerHTML = targets.map(target => {
        const msgs = privateChatSession[target] || [];
        const unreadForTarget = msgs.filter(m => !m.read && m.sender === target).length;
        const activeClass = target === currentChatTarget ? 'active' : '';
        const badgeHtml = unreadForTarget > 0 ? `<span class="tab-badge">${unreadForTarget}</span>` : '';
        
        return `<button class="chat-tab ${activeClass}" onclick="switchChatTab('${escapeHtml(target)}')">
            ${escapeHtml(target)}${badgeHtml}
        </button>`;
    }).join('');
}

window.switchChatTab = function(targetName) {
    currentChatTarget = targetName;
    if (privateChatSession[targetName]) {
        privateChatSession[targetName].forEach(m => m.read = true);
    }
    // Update global unread count
    let totalUnread = 0;
    Object.values(privateChatSession).forEach(msgs => {
        totalUnread += msgs.filter(m => !m.read && m.sender !== getMyName()).length;
    });
    unreadMessagesCount = totalUnread;
    updateChatBadge();
    
    renderChatTabs();
    renderChatMessages();
    const chatInput = document.getElementById('chat-input');
    if (chatInput) chatInput.focus();
};

window.openPrivateChat = function(targetName) {
    if (!privateChatSession[targetName]) {
        privateChatSession[targetName] = [];
    }
    currentChatTarget = targetName;
    const chatPanel = document.getElementById('private-chat-panel');
    const chatToggleBtn = document.getElementById('private-chat-toggle');
    
    if (chatPanel) chatPanel.classList.remove('hidden');
    if (chatToggleBtn) chatToggleBtn.classList.add('hidden');
    
    switchChatTab(targetName);
};

function closePrivateChat() {
    if (chatPanel) chatPanel.classList.add('hidden');
    if (chatToggleBtn) {
        if (Object.keys(privateChatSession).length > 0) {
            chatToggleBtn.classList.remove('hidden');
        }
    }
}

if (chatCloseBtn) chatCloseBtn.addEventListener('click', closePrivateChat);
if (chatToggleBtn) {
    chatToggleBtn.addEventListener('click', () => {
        let target = currentChatTarget;
        if (!target) {
            const users = Object.keys(privateChatSession);
            if (users.length > 0) {
                target = users.find(u => privateChatSession[u].some(m => !m.read && m.sender === u)) || users[0];
            }
        }
        if (target) {
            openPrivateChat(target);
        }
    });
}

const btnChatOpponent = document.getElementById('btn-chat-opponent');
if (btnChatOpponent) {
    btnChatOpponent.addEventListener('click', () => {
        const opponentName = players[mySymbol === 'X' ? 'O' : 'X'];
        if (opponentName && opponentName !== 'Aguardando...') {
            openPrivateChat(opponentName);
        }
    });
}

function renderChatMessages() {
    if (!currentChatTarget || !chatMessages) return;
    const msgs = privateChatSession[currentChatTarget] || [];
    if (msgs.length === 0) {
        chatMessages.innerHTML = '<div class="chat-empty">Nenhuma mensagem ainda.</div>';
    } else {
        chatMessages.innerHTML = msgs.map(m => {
            const isMe = m.sender === getMyName();
            const cls = isMe ? 'sent' : 'received';
            return `<div class="chat-msg ${cls}">${escapeHtml(m.text)}</div>`;
        }).join('');
    }
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function sendPrivateMessage() {
    if (!currentChatTarget || !chatInput) return;
    const text = chatInput.value.trim();
    if (!text) return;
    
    wsSend({ type: 'privateMessage', target: currentChatTarget, text });
    
    // Adiciona localmente de forma imediata
    if (!privateChatSession[currentChatTarget]) privateChatSession[currentChatTarget] = [];
    privateChatSession[currentChatTarget].push({ sender: getMyName(), text, read: true });
    
    renderChatTabs();
    renderChatMessages();
    chatInput.value = '';
}

if (chatSendBtn) chatSendBtn.addEventListener('click', sendPrivateMessage);
if (chatInput) {
    chatInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') sendPrivateMessage();
    });
}
