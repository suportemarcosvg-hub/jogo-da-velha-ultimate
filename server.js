/**
 * Jogo da Velha 2 – Servidor Multiplayer
 * Express + WebSocket com persistência de salas (30min) e reconexão
 */

'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');


const PORT = process.env.PORT || 2026;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));

mongoose.connect(process.env.MONGODB_URI).then(() => console.log('MongoDB Conectado!')).catch(console.error);

const userSchema = new mongoose.Schema({
    username: String,
    key: { type: String, unique: true },
    passwordHash: String,
    securityQuestion: String,
    securityAnswerHash: String,
    createdAt: Date
});
const User = mongoose.model('User', userSchema);

const pairSchema = new mongoose.Schema({
    key: { type: String, unique: true },
    players: [String],
    playerKeys: [String],
    wins: { type: Map, of: Number },
    draws: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    lastPlayed: Date,
    lastStarter: String
});
const Pair = mongoose.model('Pair', pairSchema);

const matchSchema = new mongoose.Schema({
    date: Date,
    players: { X: String, O: String },
    playerKeys: [String],
    winner: String,
    moves: Array
});
const Match = mongoose.model('Match', matchSchema);

function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

function cleanName(name) {
    return String(name || '').trim().slice(0, 16) || 'Jogador';
}

function playerKey(name) {
    return cleanName(name).toLocaleLowerCase('pt-BR');
}

function pairKey(nameA, nameB) {
    return [playerKey(nameA), playerKey(nameB)].sort().join('::');
}


async function getPairRecord(nameA, nameB) {
    const key = pairKey(nameA, nameB);
    let pair = await Pair.findOne({ key });
    if (!pair) {
        const ordered = [cleanName(nameA), cleanName(nameB)].sort((a, b) => a.localeCompare(b, 'pt-BR'));
        pair = new Pair({
            key,
            players: ordered,
            playerKeys: [playerKey(nameA), playerKey(nameB)],
            wins: { [ordered[0]]: 0, [ordered[1]]: 0 },
            draws: 0,
            total: 0,
            lastPlayed: null,
            lastStarter: null
        });
        await pair.save();
    }
    return pair;
}

function getStartingSymbolForPair(playerXName, playerOName) {
    const pX = cleanName(playerXName);
    const pO = cleanName(playerOName);
    const record = getPairRecord(pX, pO);
    
    if (!record.lastStarter || record.lastStarter === pO) {
        record.lastStarter = pX;
        return 'X';
    } else {
        record.lastStarter = pO;
        return 'O';
    }
}

function recordMatch(nameX, nameO, winnerSymbol, moves = []) {
    const playerX = cleanName(nameX);
    const playerO = cleanName(nameO);
    const record = getPairRecord(playerX, playerO);
    const winnerName = winnerSymbol === 'X' ? playerX : winnerSymbol === 'O' ? playerO : null;

    record.total += 1;
    record.lastPlayed = new Date().toISOString();
    if (winnerName) {
        record.wins[winnerName] = (record.wins[winnerName] || 0) + 1;
    } else {
        record.draws += 1;
    }

    matchHistory.matches.unshift({
        id: generateCode(),
        players: { X: playerX, O: playerO },
        winner: winnerName || 'Empate',
        winnerSymbol,
        playedAt: record.lastPlayed,
        moves: moves
    });
    matchHistory.matches = matchHistory.matches.slice(0, 200);
    
    return record;
}

function formatPairScore(nameX, nameO) {
    const record = getPairRecord(nameX, nameO);
    return {
        X: record.wins[cleanName(nameX)] || 0,
        O: record.wins[cleanName(nameO)] || 0,
        draws: record.draws,
        total: record.total
    };
}

app.get('/api/history', async (req, res) => {
    const player = cleanName(req.query.player || '');
    const key = playerKey(player);
    const pairs = await Pair.find({ playerKeys: key })
        .sort({ lastPlayed: -1 })
        .limit(20);
    res.json({ player, pairs });
});

app.get('/api/matches', async (req, res) => {
    const player = cleanName(req.query.player || '');
    const key = playerKey(player);
    const matches = await Match.find({ playerKeys: key })
        .sort({ date: -1 })
        .limit(5);
    res.json({ player, matches });
});

app.post('/api/register', async (req, res) => {
    const { username, password, securityQuestion, securityAnswer } = req.body;
    if (!username || !password || !securityQuestion || !securityAnswer) return res.status(400).json({ error: 'Todos os campos (incluindo pergunta de segurança) são obrigatórios.' });
    const cleanU = cleanName(username);
    const key = playerKey(cleanU);
    if (key.length < 3) return res.status(400).json({ error: 'O nome de usuário deve ter pelo menos 3 caracteres.' });
    if (password.length < 4) return res.status(400).json({ error: 'A senha deve ter pelo menos 4 caracteres.' });
    if (securityAnswer.length < 2) return res.status(400).json({ error: 'A resposta de segurança deve ter pelo menos 2 caracteres.' });

    const existing = await User.findOne({ key });
    if (existing) return res.status(400).json({ error: 'Nome de usuário já cadastrado.' });

    const user = new User({
        username: cleanU,
        key: key,
        passwordHash: hashPassword(password),
        securityQuestion: securityQuestion,
        securityAnswerHash: hashPassword(securityAnswer.trim().toLowerCase()),
        createdAt: new Date()
    });
    await user.save();
    res.json({ success: true, username: cleanU });
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    const key = playerKey(username);
    const user = await User.findOne({ key });

    if (!user || user.passwordHash !== hashPassword(password)) {
        return res.status(400).json({ error: 'Usuário ou senha incorretos.' });
    }
    res.json({ success: true, username: user.username });
});

app.post('/api/recover/question', async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Nome de usuário obrigatório.' });
    const key = playerKey(username);
    const user = await User.findOne({ key });
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado.' });
    if (!user.securityQuestion) return res.status(400).json({ error: 'Este usuário é antigo e não possui pergunta de segurança cadastrada.' });
    res.json({ success: true, question: user.securityQuestion });
});

app.post('/api/recover/reset', async (req, res) => {
    const { username, securityAnswer, newPassword } = req.body;
    if (!username || !securityAnswer || !newPassword) return res.status(400).json({ error: 'Preencha todos os campos.' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 4 caracteres.' });
    
    const key = playerKey(username);
    const user = await User.findOne({ key });
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado.' });
    
    const answerHash = hashPassword(securityAnswer.trim().toLowerCase());
    if (user.securityAnswerHash !== answerHash) {
        return res.status(400).json({ error: 'Resposta de segurança incorreta.' });
    }

    user.passwordHash = hashPassword(newPassword);
    await user.save();
    res.json({ success: true });
});

app.post('/api/change-password', async (req, res) => {
    const { username, currentPassword, newPassword } = req.body;
    if (!username || !currentPassword || !newPassword) return res.status(400).json({ error: 'Preencha todos os campos.' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 4 caracteres.' });

    const key = playerKey(username);
    const user = await User.findOne({ key });
    if (!user) return res.status(400).json({ error: 'Usuário não encontrado.' });

    if (user.passwordHash !== hashPassword(currentPassword)) {
        return res.status(400).json({ error: 'A senha atual está incorreta.' });
    }

    user.passwordHash = hashPassword(newPassword);
    await user.save();
    res.json({ success: true });
});


// ── Gerenciamento de Salas e Usuários Online ───────────────────────────────────

const rooms = new Map();
const ROOM_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

// Rastreia usuários online ativos: username -> Set(ws)
const onlineClients = new Map();

function resetRoomTimeout(room) {
    if (room.timeout) clearTimeout(room.timeout);
    room.timeout = setTimeout(() => {
        rooms.delete(room.code);
        broadcastLobbyState();
        console.log(`[-] Sala ${room.code} removida por inatividade.`);
    }, ROOM_TIMEOUT_MS);
}

function getLobbyState() {
    const activeRooms = [];
    rooms.forEach((room, code) => {
        const creator = room.players[0] ? room.players[0].name : 'Desconhecido';
        const count = room.players.filter(p => p !== null).length;
        activeRooms.push({
            code,
            creator,
            playersCount: count,
            started: room.started
        });
    });

    const activeUsers = Array.from(onlineClients.keys());

    return {
        type: 'onlineLobbyState',
        rooms: activeRooms,
        users: activeUsers
    };
}

function broadcastLobbyState() {
    const state = getLobbyState();
    const raw = JSON.stringify(state);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(raw);
        }
    });
}

function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function generateId() {
    return crypto.randomBytes(16).toString('hex');
}

const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
];

function checkWinner(board) {
    for (let i = 0; i < WIN_LINES.length; i++) {
        const [a, b, c] = WIN_LINES[i];
        if (board[a] && board[a] === board[b] && board[a] === board[c]) {
            return { winner: board[a], line: WIN_LINES[i] };
        }
    }
    if (board.every(cell => cell !== null)) return 'draw';
    return null;
}

function createInitialGameState(startingSymbol = 'X') {
    return {
        cells: Array.from({ length: 9 }, () => Array(9).fill(null)),
        macroBoard: Array(9).fill(null),
        currentPlayer: startingSymbol,
        activeBoard: null,
        gameOver: false,
        winner: null,
        winLine: null,
        matchRecorded: false,
        startTime: Date.now()
    };
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data) {
    if (!room || !room.players) return;
    room.players.forEach(p => {
        if (p && p.connected && p.ws) {
            send(p.ws, data);
        }
    });
}

const pendingMatches_real = new Map();

const pendingMatches = {
    has: (k) => pendingMatches_real.has(k),
    get: (k) => pendingMatches_real.get(k),
    set: (k, v) => {
        pendingMatches_real.set(k, v);
        
    },
    delete: (k) => {
        pendingMatches_real.delete(k);
        
    }
};

wss.on('connection', ws => {
    let playerRoom = null;
    let playerIdx = null; // 0 para criador (X), 1 para entrante (O)
    let loggedUser = null;

    ws.on('message', async message => {
        try {
            const msg = JSON.parse(message);

            switch (msg.type) {

                case 'enterLobby': {
                    if (msg.name) {
                        loggedUser = msg.name;
                        let sockets = onlineClients.get(loggedUser);
                        if (!sockets) {
                            sockets = new Set();
                            onlineClients.set(loggedUser, sockets);
                        }
                        sockets.add(ws);

                        console.log(`[+] Usuário conectado no lobby: ${loggedUser} às ${new Date().toLocaleString('pt-BR')}`);
                        broadcastLobbyState();
                        
                        send(ws, getLobbyState()); // Envia o estado inicial para quem acabou de entrar
                    }
                    break;
                }

                case 'createRoom': {
                    const code = generateCode();
                    const pId = generateId();
                    const room = {
                        code,
                        players: [{ ws, name: msg.name || 'Jogador X', symbol: 'X', id: pId, connected: true }, null],
                        state: null,
                        started: false,
                        timeout: null
                    };
                    rooms.set(code, room);
                    playerRoom = room;
                    playerIdx = 0;
                    resetRoomTimeout(room);

                    send(ws, { type: 'roomCreated', code, playerId: pId, state: room.state });
                    console.log(`[+] Sala ${code} criada por ${msg.name}`);
                    broadcastLobbyState();
                    break;
                }

                case 'joinRoom': {
                    const code = (msg.code || '').toUpperCase().trim();
                const room = rooms.get(code);

                if (!room) {
                    send(ws, { type: 'error', msg: 'Sala não encontrada. Verifique o código.' });
                    return;
                }
                if (room.players[0] && cleanName(room.players[0].name) === cleanName(msg.name)) {
                    send(ws, { type: 'error', msg: 'Você não pode entrar na sala que você mesmo criou.' });
                    return;
                }
                if (room.players[1]) {
                    send(ws, { type: 'error', msg: 'Sala cheia. Tente outro código.' });
                    return;
                }
                if (room.started) {
                    send(ws, { type: 'error', msg: 'Partida já iniciada nesta sala.' });
                    return;
                }

                const pId = generateId();
                room.players[1] = { ws, name: msg.name || 'Jogador O', symbol: 'O', id: pId, connected: true };
                playerRoom = room;
                playerIdx = 1;
                const playerXName = room.players[0].name;
                const playerOName = msg.name || 'Jogador O';
                const matchKey = pairKey(playerXName, playerOName);
                room.started = true;
                if (pendingMatches.has(matchKey)) {
                    const pending = pendingMatches.get(matchKey);
                    room.state = pending.state || pending;
                    room.moves = pending.moves || [];
                } else {
                    const startingSymbol = getStartingSymbolForPair(playerXName, playerOName);
                    room.state = createInitialGameState(startingSymbol);
                    room.moves = [];
                }
                resetRoomTimeout(room);

                // Avisa ambos os jogadores e envia playerId pro joiner
                send(room.players[0].ws, {
                    type: 'gameStart',
                    symbol: 'X',
                    myName: room.players[0].name,
                    opponentName: room.players[1].name,
                    state: room.state,
                    headToHead: await formatPairScore(room.players[0].name, room.players[1].name)
                });
                send(room.players[1].ws, {
                    type: 'gameStart',
                    symbol: 'O',
                    myName: room.players[1].name,
                    opponentName: room.players[0].name,
                    state: room.state,
                    playerId: pId,
                    headToHead: await formatPairScore(room.players[0].name, room.players[1].name)
                });

                console.log(`[>] Jogo iniciado em "${code}": ${room.players[0].name}(X) vs ${room.players[1].name}(O) às ${new Date().toLocaleString('pt-BR')}`);
                broadcastLobbyState();
                break;
            }

            // ── Enviar convite de partida ───────────────────────────────────────────
            case 'invitePlayer': {
                const targetUser = msg.target;
                const senderUser = msg.sender;
                
                if (!targetUser || !senderUser) return;
                
                const targetSockets = onlineClients.get(targetUser);
                if (targetSockets && targetSockets.size > 0) {
                    targetSockets.forEach(targetWs => {
                        send(targetWs, {
                            type: 'matchInvite',
                            sender: senderUser
                        });
                    });
                } else {
                    send(ws, { type: 'error', msg: `Jogador ${targetUser} não está mais online.` });
                }
                break;
            }

            // ── Responder a convite de partida ──────────────────────────────────────
            case 'inviteResponse': {
                const senderUser = msg.sender; // Quem enviou o convite inicialmente
                const responderUser = loggedUser || msg.responder; // Quem está respondendo
                const accepted = msg.accepted;
                
                const senderSockets = onlineClients.get(senderUser);
                
                if (!accepted) {
                    if (senderSockets) {
                        senderSockets.forEach(senderWs => {
                            send(senderWs, { type: 'inviteDeclined', responder: responderUser });
                        });
                    }
                    break;
                }
                
                // Se aceitou, cria uma sala nova automaticamente para os dois e os coloca nela
                const code = generateCode();
                const pIdX = generateId();
                const pIdO = generateId();
                
                const matchKey = pairKey(senderUser, responderUser);
                
                // Primeiro verifica se os dois já não estão numa sala ativa!
                let existingRoom = null;
                rooms.forEach((r) => {
                    if (!r.state.gameOver && r.players[0] && r.players[1]) {
                        const p0 = cleanName(r.players[0].name);
                        const p1 = cleanName(r.players[1].name);
                        const s = cleanName(senderUser);
                        const rN = cleanName(responderUser);
                        if ((p0 === s && p1 === rN) || (p0 === rN && p1 === s)) {
                            existingRoom = r;
                        }
                    }
                });

                if (existingRoom) {
                    // Tem sala ativa aguardando os 60s! Manda os dois de volta pra ela.
                    const pX = existingRoom.players[0];
                    const pO = existingRoom.players[1];
                    
                    if (senderSockets) {
                        senderSockets.forEach(ws => send(ws, {
                            type: 'inviteAcceptedRedirect',
                            code: existingRoom.code,
                            symbol: pX.name === senderUser ? pX.symbol : pO.symbol,
                            playerId: pX.name === senderUser ? pX.id : pO.id,
                            opponentName: responderUser
                        }));
                    }
                    const responderSockets = onlineClients.get(responderUser);
                    if (responderSockets) {
                        responderSockets.forEach(ws => send(ws, {
                            type: 'inviteAcceptedRedirect',
                            code: existingRoom.code,
                            symbol: pX.name === responderUser ? pX.symbol : pO.symbol,
                            playerId: pX.name === responderUser ? pX.id : pO.id,
                            opponentName: senderUser
                        }));
                    }
                    break;
                }

                let initialState;
                let initialMoves = [];
                if (pendingMatches.has(matchKey)) {
                    const pending = pendingMatches.get(matchKey);
                    initialState = pending.state || pending;
                    initialMoves = pending.moves || [];
                    pendingMatches.delete(matchKey);
                } else {
                    const startingSymbol = getStartingSymbolForPair(senderUser, responderUser);
                    initialState = createInitialGameState(startingSymbol);
                }

                const room = {
                    code,
                    players: [
                        { ws: null, name: senderUser, symbol: 'X', id: pIdX, connected: false },
                        { ws: null, name: responderUser, symbol: 'O', id: pIdO, connected: false }
                    ],
                    state: initialState,
                    started: true,
                    moves: initialMoves
                };
                
                rooms.set(code, room);
                resetRoomTimeout(room);
                console.log(`[>] Jogo (convite) iniciado em "${code}": ${room.players[0].name}(X) vs ${room.players[1].name}(O) às ${new Date().toLocaleString('pt-BR')}`);
                
                // Conecta e redireciona ambos
                if (senderSockets) {
                    senderSockets.forEach(senderWs => {
                        send(senderWs, {
                            type: 'inviteAcceptedRedirect',
                            code,
                            symbol: 'X',
                            playerId: pIdX,
                            opponentName: responderUser
                        });
                    });
                }
                
                const responderSockets = onlineClients.get(responderUser);
                if (responderSockets) {
                    responderSockets.forEach(respWs => {
                        send(respWs, {
                            type: 'inviteAcceptedRedirect',
                            code,
                            symbol: 'O',
                            playerId: pIdO,
                            opponentName: senderUser
                        });
                    });
                }
                
                broadcastLobbyState();
                break;
            }

            // ── Reconectar na sala ──────────────────────────────────────────────────
            case 'rejoinRoom': {
                const code = (msg.code || '').toUpperCase().trim();
                const pId = msg.playerId;
                const room = rooms.get(code);

                if (!room) {
                    send(ws, { type: 'rejoinFailed', msg: 'Sala expirou ou não existe.' });
                    return;
                }

                const pIndex = room.players.findIndex(p => p && p.id === pId);
                if (pIndex === -1) {
                    // Tenta associar por nome se o ID não bater (ex: redirecionamento de convite)
                    const pNameIndex = room.players.findIndex(p => p && cleanName(p.name) === cleanName(loggedUser));
                    if (pNameIndex !== -1) {
                        const p = room.players[pNameIndex];
                        p.ws = ws;
                        p.connected = true;
                        p.id = pId; // atualiza com o que veio do cliente
                        playerRoom = room;
                        playerIdx = pNameIndex;
                        resetRoomTimeout(room);
                        if (room.disconnectTimeout) {
                            clearTimeout(room.disconnectTimeout);
                            room.disconnectTimeout = null;
                        }
                        
                        const opponent = room.players[pNameIndex === 0 ? 1 : 0];
                        const opponentName = opponent ? opponent.name : 'Oponente';
                        
                        send(ws, {
                            type: 'rejoined',
                            symbol: p.symbol,
                            myName: p.name,
                            opponentName: opponentName,
                            state: room.state,
                            headToHead: opponent ? formatPairScore(room.players[0].name, room.players[1].name) : null
                        });
                        
                        if (opponent && opponent.connected) {
                            send(opponent.ws, { type: 'opponentRejoined' });
                        }
                        console.log(`[^] Jogador reconectado via convite em "${code}": ${p.name}`);
                        return;
                    }
                    send(ws, { type: 'rejoinFailed', msg: 'Sessão inválida.' });
                    return;
                }

                // Restaura a conexão do jogador
                const p = room.players[pIndex];
                p.ws = ws;
                p.connected = true;
                playerRoom = room;
                playerIdx = pIndex;
                resetRoomTimeout(room);
                if (room.disconnectTimeout) {
                    clearTimeout(room.disconnectTimeout);
                    room.disconnectTimeout = null;
                }

                // Informa que reconectou com sucesso
                const opponent = room.players[pIndex === 0 ? 1 : 0];
                const opponentName = opponent ? opponent.name : 'Oponente';

                send(ws, {
                    type: 'rejoined',
                    symbol: p.symbol,
                    myName: p.name,
                    opponentName: opponentName,
                    state: room.state,
                    headToHead: opponent ? formatPairScore(room.players[0].name, room.players[1].name) : null
                });

                // Avisa o oponente se ele estiver conectado
                if (opponent && opponent.connected) {
                    send(opponent.ws, { type: 'opponentRejoined' });
                }

                console.log(`[^] Jogador reconectado em "${code}": ${p.name}`);
                break;
            }

            // ── Chat Privado ──────────────────────────────────────────────────────────
            case 'privateMessage': {
                if (!loggedUser) break;
                const target = cleanName(msg.target);
                const text = msg.text;
                if (!text || !target) break;

                const targetSockets = onlineClients.get(target);
                if (targetSockets) {
                    targetSockets.forEach(targetWs => {
                        send(targetWs, {
                            type: 'privateMessage',
                            sender: loggedUser,
                            text: text
                        });
                    });
                }
                break;
            }

            // ── Desistir da Partida ─────────────────────────────────────────────────
            case 'surrender': {
                if (!playerRoom || !playerRoom.state || playerRoom.state.gameOver) return;
                const st = playerRoom.state;
                st.gameOver = true;
                st.winner = playerIdx === 0 ? 'O' : 'X';
                
                if (!st.matchRecorded) {
                    st.matchRecorded = true;
                    playerRoom.headToHead = await recordMatch(playerRoom.players[0].name, playerRoom.players[1].name, st.winner, playerRoom.moves || []);
                    const matchKey = pairKey(playerRoom.players[0].name, playerRoom.players[1].name);
                    pendingMatches.delete(matchKey);
                }
                
                broadcast(playerRoom, {
                    type: 'state',
                    state: st,
                    headToHead: formatPairScore(playerRoom.players[0].name, playerRoom.players[1].name)
                });
                const durationStr = st.startTime ? `${Math.round((Date.now() - st.startTime) / 1000)}s` : '?s';
                const winnerName = st.winner === playerRoom.players[0].symbol ? playerRoom.players[0].name : playerRoom.players[1].name;
                console.log(`[🏳️] Desistência em "${playerRoom.code}": ${playerRoom.players[0].name} vs ${playerRoom.players[1].name} | Vencedor: ${winnerName} | Duração: ${durationStr}`);
                
                // Exclui a sala conforme requisitado, pois o placar já foi dado
                if (playerRoom.timeout) clearTimeout(playerRoom.timeout);
                rooms.delete(playerRoom.code);
                
                break;
            }

            // ── Jogada ──────────────────────────────────────────────────────────────
            case 'move': {
                if (!playerRoom || !playerRoom.state) return;

                const st = playerRoom.state;
                const sym = playerRoom.players[playerIdx].symbol;
                const { boardIdx, cellIdx } = msg;

                if (st.gameOver) return;
                if (sym !== st.currentPlayer) return;
                if (st.macroBoard[boardIdx]) return;
                if (st.activeBoard !== null && st.activeBoard !== boardIdx) return;
                if (st.cells[boardIdx][cellIdx]) return;

                // Aplica jogada
                st.cells[boardIdx][cellIdx] = sym;
                if (!playerRoom.moves) playerRoom.moves = [];
                playerRoom.moves.push({ player: sym, boardIdx, cellIdx });

                // Verifica vitória no mini tabuleiro
                const miniResult = checkWinner(st.cells[boardIdx]);
                if (miniResult) {
                    st.macroBoard[boardIdx] = typeof miniResult === 'object' ? miniResult.winner : miniResult;
                }

                // Verifica vitória no tabuleiro principal
                const macroResult = checkWinner(st.macroBoard);
                if (macroResult) {
                    st.gameOver = true;
                    if (typeof macroResult === 'object') {
                        st.winner = macroResult.winner;
                        st.winLine = macroResult.line;
                    } else {
                        st.winner = 'draw';
                    }
                    if (!st.matchRecorded) {
                        st.matchRecorded = true;
                        playerRoom.headToHead = await recordMatch(playerRoom.players[0].name, playerRoom.players[1].name, st.winner, playerRoom.moves || []);
                        const matchKey = pairKey(playerRoom.players[0].name, playerRoom.players[1].name);
                        pendingMatches.delete(matchKey);
                    }
                    broadcast(playerRoom, {
                        type: 'state',
                        state: st,
                        headToHead: formatPairScore(playerRoom.players[0].name, playerRoom.players[1].name)
                    });
                    const durationStr = st.startTime ? `${Math.round((Date.now() - st.startTime) / 1000)}s` : '?s';
                    const winnerName = st.winner === playerRoom.players[0].symbol ? playerRoom.players[0].name : playerRoom.players[1].name;
                    console.log(`[🏆] Fim de jogo em "${playerRoom.code}": ${playerRoom.players[0].name} vs ${playerRoom.players[1].name} | Vencedor: ${winnerName} | Duração: ${durationStr}`);
                    return;
                }

                // Próximo tabuleiro ativo
                const nextBoard = cellIdx;
                if (st.macroBoard[nextBoard] ||
                    st.cells[nextBoard].every(c => c !== null)) {
                    st.activeBoard = null;
                } else {
                    st.activeBoard = nextBoard;
                }

                // Empate geral
                if (st.macroBoard.every(c => c !== null)) {
                    st.gameOver = true;
                    st.winner = 'draw';
                    if (!st.matchRecorded) {
                        st.matchRecorded = true;
                        playerRoom.headToHead = await recordMatch(playerRoom.players[0].name, playerRoom.players[1].name, st.winner, playerRoom.moves || []);
                        const matchKey = pairKey(playerRoom.players[0].name, playerRoom.players[1].name);
                        pendingMatches.delete(matchKey);
                    }
                    broadcast(playerRoom, {
                        type: 'state',
                        state: st,
                        headToHead: formatPairScore(playerRoom.players[0].name, playerRoom.players[1].name)
                    });
                    const durationStr = st.startTime ? `${Math.round((Date.now() - st.startTime) / 1000)}s` : '?s';
                    console.log(`[🤝] Empate geral em "${playerRoom.code}": ${playerRoom.players[0].name} vs ${playerRoom.players[1].name} | Duração: ${durationStr}`);
                    return;
                }

                st.currentPlayer = st.currentPlayer === 'X' ? 'O' : 'X';
                
                // Salva estado da partida pendente
                const matchKey = pairKey(playerRoom.players[0].name, playerRoom.players[1].name);
                pendingMatches.set(matchKey, { state: st, moves: playerRoom.moves || [] });

                broadcast(playerRoom, {
                    type: 'state',
                    state: st,
                    headToHead: formatPairScore(playerRoom.players[0].name, playerRoom.players[1].name)
                });
                break;
            }

            // ── Reiniciar ────────────────────────────────────────────────────────────
            case 'restart': {
                if (!playerRoom) return;
                playerRoom.state = createInitialGameState();
                broadcast(playerRoom, {
                    type: 'restart',
                    state: playerRoom.state,
                    headToHead: formatPairScore(playerRoom.players[0].name, playerRoom.players[1].name)
                });
                break;
            }

            // ── Pedido de Reinício (Confirmação do oponente) ──────────────────────────
            // ── Sugerir e Responder a Empate ─────────────────────────────────────────
            case 'suggestDraw': {
                if (!playerRoom) return;
                const opIdx = playerIdx === 0 ? 1 : 0;
                const op = playerRoom.players[opIdx];
                if (op && op.connected) {
                    send(op.ws, { type: 'drawRequested' });
                }
                break;
            }

            case 'drawResponse': {
                if (!playerRoom) return;
                const opIdx = playerIdx === 0 ? 1 : 0;
                const op = playerRoom.players[opIdx];
                
                if (msg.accepted) {
                    // Empate aceito. Anula o jogo atual, não dá pontos, apaga a sala.
                    if (playerRoom.state) {
                        playerRoom.state.gameOver = true;
                    }
                    const matchKey = pairKey(playerRoom.players[0].name, playerRoom.players[1].name);
                    pendingMatches.delete(matchKey);
                    
                    if (playerRoom.timeout) clearTimeout(playerRoom.timeout);
                    rooms.delete(playerRoom.code);
                    
                    broadcast(playerRoom, { type: 'drawAcceptedRedirect' });
                    console.log(`[🤝] Empate aceito em "${playerRoom.code}". Sala cancelada.`);
                } else {
                    // Empate recusado. Avisa quem sugeriu.
                    if (op && op.connected) {
                        send(op.ws, { type: 'drawDeclined' });
                    }
                }
                break;
            }

            case 'emote': {
                if (!playerRoom) return;
                const opIdx = playerIdx === 0 ? 1 : 0;
                const op = playerRoom.players[opIdx];
                if (op && op.connected) {
                    send(op.ws, { type: 'emote', content: msg.content });
                }
                break;
            }

            // ── Mudar Nome do Jogador (se ele alterou antes de reconectar/reiniciar) ──
            case 'updateName': {
                if (!playerRoom) return;
                const p = playerRoom.players[playerIdx];
                if (p && msg.name) {
                    p.name = msg.name;
                }
                break;
            }

        }
        } catch (err) {
            console.error('Erro no processamento da mensagem WebSocket:', err);
        }
    });

    ws.on('close', () => {
        if (loggedUser) {
            const sockets = onlineClients.get(loggedUser);
            if (sockets) {
                sockets.delete(ws);
                if (sockets.size === 0) {
                    onlineClients.delete(loggedUser);
                }
            }
            broadcastLobbyState();
        }

        if (!playerRoom) return;
        const room = playerRoom;

        // Marca o jogador como desconectado
        const p = room.players[playerIdx];
        if (p) {
            p.connected = false;
            p.ws = null;
        }

        // Avisa o oponente, se ele ainda estiver conectado
        const opIdx = playerIdx === 0 ? 1 : 0;
        const op = room.players[opIdx];
        if (op && op.connected) {
            if (!room.state.gameOver) {
                const p0 = room.players[0];
                const p1 = room.players[1];
                if (p0 && p1) {
                    const matchKey = pairKey(p0.name, p1.name);
                    pendingMatches.set(matchKey, { state: room.state, moves: room.moves || [] });
                    send(op.ws, { type: 'matchPausedRedirect' });
                }
                if (room.timeout) clearTimeout(room.timeout);
                rooms.delete(room.code);
                console.log(`[x] Sala "${room.code}" pausada e removida imediatamente (desconexão).`);
                broadcastLobbyState();
            } else {
                send(op.ws, { type: 'opponentLeft' });
            }
        } else {
            // Se ambos os jogadores estiverem offline
            if (room.state && room.state.gameOver) {
                if (room.timeout) clearTimeout(room.timeout);
                rooms.delete(room.code);
                console.log(`[x] Sala "${room.code}" excluída: partida encerrada e ambos saíram.`);
            } else {
                const p0 = room.players[0];
                const p1 = room.players[1];
                if (p0 && p1) {
                    const matchKey = pairKey(p0.name, p1.name);
                    pendingMatches.set(matchKey, { state: room.state, moves: room.moves || [] });
                }
                if (room.timeout) clearTimeout(room.timeout);
                rooms.delete(room.code);
                console.log(`[x] Sala "${room.code}" pausada e removida imediatamente (ambos offline).`);
                broadcastLobbyState();
            }
        }
    });

    ws.on('error', () => { });
});

// ── Inicia o servidor ────────────────────────────────────────────────────────

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\nA porta ${PORT} já está em uso.`);
        console.error('Feche o servidor antigo ou rode em outra porta, por exemplo:');
        console.error('  PowerShell: $env:PORT=2027; npm run dev');
        console.error('  CMD: set PORT=2027 && npm run dev\n');
        process.exit(1);
    }
    throw err;
});

wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
        console.error('[WebSocket] Erro:', err.message);
    }
});

server.listen(PORT, () => {
    console.log(`\n🎮 Jogo da Velha 2 – Servidor rodando na porta ${PORT}`);
    console.log(`   http://localhost:${PORT}\n`);
});
