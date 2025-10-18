/*jshint node:true*/
'use strict';

var express = require('express');
var http = require('http');
var app = express();
var server = http.createServer(app);
var { Server } = require('socket.io');
var io = new Server(server, {
    cors: {
        origin: '*',
    }
});
var bodyParser = require('body-parser');
var favicon = require('serve-favicon');
var morganLogger = require('morgan');
var port = process.env.PORT || 7000;
var four0four = require('./utils/404')();

var environment = process.env.NODE_ENV;

app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());
app.use(morganLogger('dev'));

console.log('About to crank up node');
console.log('PORT=' + port);
console.log('NODE_ENV=' + environment);

switch (environment){
    case 'build':
        console.log('** BUILD **');
        app.use(express.static('./build/'));
        // Any invalid calls for templateUrls are under app/* and should return 404
        app.use('/app/*', function(req, res, next) {
            four0four.send404(req, res);
        });
        // Any deep link calls should return index.html
        app.use('/*', express.static('./build/index.html'));
        break;
    default:
        console.log('** DEV **');
        app.use(express.static('./src/client/'));
        app.use(express.static('./'));
        app.use(express.static('./tmp'));
        // Any invalid calls for templateUrls are under app/* and should return 404
        app.use('/app/*', function(req, res, next) {
            four0four.send404(req, res);
        });
        // Any deep link calls should return index.html
        app.use('/*', express.static('./src/client/index.html'));
        break;
}

// --- Presence and Calling State ---
var usersByName = new Map(); // username -> socket.id
var userBySocketId = new Map(); // socket.id -> username
var callsById = new Map(); // callId -> { caller, callerSocketId, callee, calleeSocketId, roomId }

function broadcastPresence() {
    var list = Array.from(usersByName.keys()).sort();
    io.emit('presence', { users: list });
}

function cleanupSocket(socket) {
    var username = userBySocketId.get(socket.id);
    if (username) {
        usersByName.delete(username);
        userBySocketId.delete(socket.id);
        broadcastPresence();
    }
    // End any active calls that involve this socket
    Array.from(callsById.entries()).forEach(function(entry){
        var callId = entry[0];
        var call = entry[1];
        if (call.callerSocketId === socket.id || call.calleeSocketId === socket.id) {
            var otherSocketId = call.callerSocketId === socket.id ? call.calleeSocketId : call.callerSocketId;
            io.to(otherSocketId).emit('call-ended', { callId: callId, reason: 'peer-disconnected' });
            if (call.roomId) {
                io.in(call.roomId).emit('peer-left', { socketId: socket.id });
            }
            callsById.delete(callId);
        }
    });
}

function makeCallId() {
    return 'call-' + Math.random().toString(36).slice(2, 10);
}

// --- Simple Socket.IO signaling ---
// Rooms are identified by a string (e.g., "public" or user-selected code)
// We forward SDP offers/answers and ICE candidates between peers in the same room
io.on('connection', function(socket) {
    // Registration & presence
    socket.on('register', function(payload) {
        var username = (payload && payload.username || '').trim();
        if (!username) {
            socket.emit('register-result', { ok: false, error: 'empty_username' });
            return;
        }
        if (usersByName.has(username)) {
            socket.emit('register-result', { ok: false, error: 'username_taken' });
            return;
        }
        usersByName.set(username, socket.id);
        userBySocketId.set(socket.id, username);
        socket.emit('register-result', { ok: true, username: username });
        broadcastPresence();
    });

    // Call invite -> accept/decline
    socket.on('invite', function(payload) {
        var fromUser = userBySocketId.get(socket.id);
        if (!fromUser) {
            socket.emit('invite-result', { ok: false, error: 'not_registered' });
            return;
        }
        var toUser = payload && payload.to;
        var calleeSocketId = toUser ? usersByName.get(toUser) : null;
        if (!calleeSocketId) {
            socket.emit('invite-result', { ok: false, error: 'user_offline' });
            return;
        }
        var callId = makeCallId();
        callsById.set(callId, {
            caller: fromUser,
            callerSocketId: socket.id,
            callee: toUser,
            calleeSocketId: calleeSocketId,
            roomId: null
        });
        socket.emit('invite-result', { ok: true, callId: callId, to: toUser });
        io.to(calleeSocketId).emit('incoming-call', { callId: callId, from: fromUser });
    });

    socket.on('accept', function(payload) {
        var callId = payload && payload.callId;
        var call = callId ? callsById.get(callId) : null;
        if (!call) return;
        if (socket.id !== call.calleeSocketId) return;
        var roomId = 'call:' + callId;
        call.roomId = roomId;
        // Notify both sides; clients will join and start WebRTC flow
        io.to(call.callerSocketId).emit('call-accepted', { callId: callId, roomId: roomId, role: 'caller' });
        io.to(call.calleeSocketId).emit('call-accepted', { callId: callId, roomId: roomId, role: 'callee' });
    });

    socket.on('decline', function(payload) {
        var callId = payload && payload.callId;
        var call = callId ? callsById.get(callId) : null;
        if (!call) return;
        if (socket.id !== call.calleeSocketId) return;
        io.to(call.callerSocketId).emit('call-declined', { callId: callId });
        callsById.delete(callId);
    });

    socket.on('end-call', function(payload) {
        var callId = payload && payload.callId;
        var call = callId ? callsById.get(callId) : null;
        if (!call) return;
        var otherSocketId = (socket.id === call.callerSocketId) ? call.calleeSocketId : call.callerSocketId;
        io.to(otherSocketId).emit('call-ended', { callId: callId, reason: 'hangup' });
        if (call.roomId) {
            io.in(call.roomId).emit('peer-left', { socketId: socket.id });
        }
        callsById.delete(callId);
    });

    socket.on('join', function(roomId) {
        socket.join(roomId);
        var numClients = io.sockets.adapter.rooms.get(roomId)?.size || 0;
        socket.emit('joined', { roomId: roomId, numClients: numClients });
        socket.to(roomId).emit('peer-joined', { socketId: socket.id, numClients: numClients });
    });

    socket.on('signal', function(payload) {
        var roomId = payload && payload.roomId;
        if (!roomId) return;
        // broadcast to everyone else in the room
        socket.to(roomId).emit('signal', {
            from: socket.id,
            data: payload.data
        });
    });

    socket.on('leave', function(roomId) {
        socket.leave(roomId);
        socket.to(roomId).emit('peer-left', { socketId: socket.id });
    });

    socket.on('disconnect', function() {
        cleanupSocket(socket);
        // Room-specific notifications aren't trivial without tracking per-socket rooms
        // Clients can handle reconnection as needed
    });
});

server.listen(port, function() {
    console.log('Express server listening on port ' + port);
    console.log('env = ' + app.get('env') +
        '\n__dirname = ' + __dirname  +
        '\nprocess.cwd = ' + process.cwd());
});
