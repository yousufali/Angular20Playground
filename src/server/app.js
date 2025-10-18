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

// --- Simple Socket.IO signaling ---
// Rooms are identified by a string (e.g., "public" or user-selected code)
// We forward SDP offers/answers and ICE candidates between peers in the same room
io.on('connection', function(socket) {
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
