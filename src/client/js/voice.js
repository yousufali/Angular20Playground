"use strict";

// Voice calling client with presence + invites over Socket.IO and WebRTC audio
(function () {
  // --- State ---
  var socket = null;
  var username = null;
  var users = [];

  var call = {
    id: null,
    roomId: null,
    role: null, // 'caller' | 'callee'
  };

  var peerConnection = null;
  var localStream = null;
  var isMuted = false;

  // UI elements (assigned on DOMContentLoaded)
  var els = {};

  function $(id) { return document.getElementById(id); }

  function setText(el, text) { if (el) el.textContent = text; }
  function show(el) { if (el) el.style.display = ""; }
  function hide(el) { if (el) el.style.display = "none"; }

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["[voice]"].concat(args));
  }

  // --- Socket helpers ---
  function ensureSocket() {
    if (!socket) {
      socket = io();
      wireSocketEvents();
    }
    return socket;
  }

  function wireSocketEvents() {
    socket.on("register-result", function (res) {
      if (res.ok) {
        username = res.username;
        setText(els.meName, username);
        hide(els.registerForm);
        show(els.appArea);
      } else {
        alert(res.error === 'username_taken' ? "Username is taken" : "Invalid username");
      }
    });

    socket.on("presence", function (payload) {
      users = (payload && payload.users) || [];
      renderUsers();
    });

    socket.on("incoming-call", function (payload) {
      call.id = payload.callId;
      call.role = 'callee';
      setText(els.incomingText, "Incoming call from " + payload.from);
      show(els.incomingPanel);
    });

    socket.on("invite-result", function (res) {
      if (!res.ok) {
        alert(res.error === 'user_offline' ? "User is offline" : "You must register first");
        return;
      }
      call.id = res.callId;
      call.role = 'caller';
      setText(els.statusText, "Calling " + res.to + "...");
      show(els.hangBtn);
    });

    socket.on("call-accepted", function (payload) {
      call.roomId = payload.roomId;
      // Both peers join the room and start WebRTC
      joinRoom(call.roomId).then(function () {
        if (call.role === 'caller') {
          makeOffer();
        }
      });
      setText(els.statusText, "In call");
      hide(els.incomingPanel);
      show(els.hangBtn);
    });

    socket.on("call-declined", function (_payload) {
      setText(els.statusText, "Call declined");
      resetCall();
    });

    socket.on("call-ended", function (_payload) {
      setText(els.statusText, "Call ended");
      teardownPeer();
      resetCall();
    });

    socket.on("signal", onSocketSignal);

    socket.on("peer-joined", function (_info) {
      // Existing peer waits; caller will create offer after joining
    });
  }

  // --- Presence UI ---
  function renderUsers() {
    if (!els.usersList) return;
    els.usersList.innerHTML = "";
    users.filter(function (u) { return u !== username; }).forEach(function (u) {
      var li = document.createElement("li");
      li.textContent = u + " ";
      var btn = document.createElement("button");
      btn.textContent = "Call";
      btn.addEventListener("click", function () { startCall(u); });
      li.appendChild(btn);
      els.usersList.appendChild(li);
    });
  }

  // --- Call control ---
  function register() {
    var name = (els.usernameInput.value || "").trim();
    if (!name) { alert("Enter a username"); return; }
    ensureSocket().emit("register", { username: name });
  }

  function startCall(targetUser) {
    if (!username) { alert("Register first"); return; }
    ensureSocket().emit("invite", { to: targetUser });
  }

  function acceptCall() {
    ensureSocket().emit("accept", { callId: call.id });
  }

  function declineCall() {
    ensureSocket().emit("decline", { callId: call.id });
    hide(els.incomingPanel);
    resetCall();
  }

  function hangUp() {
    if (call.id) {
      ensureSocket().emit("end-call", { callId: call.id });
    }
    teardownPeer();
    resetCall();
  }

  function resetCall() {
    call.id = null;
    call.roomId = null;
    call.role = null;
    hide(els.hangBtn);
  }

  // --- WebRTC bits ---
  function sendSignal(data) {
    if (!socket || !call.roomId) return;
    socket.emit("signal", { data: data, roomId: call.roomId });
  }

  function onSocketSignal(msg) {
    var data = msg && msg.data;
    if (!data) return;

    if (!peerConnection) {
      createPeerConnection();
    }

    if (data.type === "offer") {
      peerConnection.setRemoteDescription(new RTCSessionDescription(data))
        .then(function () { return peerConnection.createAnswer(); })
        .then(function (answer) {
          return peerConnection.setLocalDescription(answer).then(function () {
            sendSignal({ type: "answer", sdp: answer.sdp });
          });
        })
        .catch(function (err) { console.error("answer flow failed", err); });
    } else if (data.type === "answer") {
      peerConnection.setRemoteDescription(new RTCSessionDescription(data))
        .catch(function (err) { console.error("setRemoteDescription(answer) failed", err); });
    } else if (data.candidate) {
      peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
        .catch(function (err) { console.error("addIceCandidate failed", err); });
    }
  }

  function createPeerConnection() {
    if (peerConnection) return peerConnection;
    var pc = new RTCPeerConnection({
      iceServers: [ { urls: "stun:stun.l.google.com:19302" } ]
    });

    pc.onicecandidate = function (event) {
      if (event.candidate) {
        sendSignal({ candidate: event.candidate });
      }
    };

    pc.ontrack = function (event) {
      var stream = event.streams[0];
      if (els.remoteAudio) {
        try { els.remoteAudio.srcObject = stream; }
        catch (e) { els.remoteAudio.src = window.URL.createObjectURL(stream); }
        els.remoteAudio.play().catch(function () { /* autoplay might need a gesture */ });
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(function (track) { pc.addTrack(track, localStream); });
    }

    peerConnection = pc;
    return pc;
  }

  function makeOffer() {
    if (!peerConnection) return Promise.resolve();
    return peerConnection.createOffer()
      .then(function (offer) {
        return peerConnection.setLocalDescription(offer).then(function () {
          sendSignal({ type: "offer", sdp: offer.sdp });
        });
      })
      .catch(function (err) { console.error("offer flow failed", err); });
  }

  function joinRoom(id) {
    if (!id) return Promise.resolve();
    call.roomId = id;
    if (!socket) ensureSocket();
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (stream) {
        localStream = stream;
        if (els.localAudio) {
          try { els.localAudio.srcObject = stream; }
          catch (e) { els.localAudio.src = window.URL.createObjectURL(stream); }
        }
        createPeerConnection();
        socket.emit("join", id);
      })
      .catch(function (err) {
        console.error("getUserMedia failed", err);
        alert("Microphone permission was denied or not available.");
      });
  }

  function teardownPeer() {
    if (peerConnection) { try { peerConnection.close(); } catch (e) {} peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    setText(els.muteBtn, isMuted ? "Unmute" : "Mute");
  }

  // --- UI wiring ---
  function wireUI() {
    els.registerForm = $("registerForm");
    els.usernameInput = $("username");
    els.registerBtn = $("registerBtn");
    els.meName = $("meName");

    els.appArea = $("appArea");
    els.usersList = $("users");
    els.statusText = $("status");

    els.incomingPanel = $("incomingPanel");
    els.incomingText = $("incomingText");
    els.acceptBtn = $("acceptBtn");
    els.declineBtn = $("declineBtn");

    els.localAudio = $("localAudio");
    els.remoteAudio = $("remoteAudio");
    els.muteBtn = $("muteBtn");
    els.hangBtn = $("hangBtn");

    // Show registration first
    show(els.registerForm);
    hide(els.appArea);
    hide(els.incomingPanel);
    hide(els.hangBtn);

    els.registerBtn.addEventListener("click", function () { register(); });
    els.acceptBtn.addEventListener("click", function () { acceptCall(); });
    els.declineBtn.addEventListener("click", function () { declineCall(); });
    els.muteBtn.addEventListener("click", function () { toggleMute(); });
    els.hangBtn.addEventListener("click", function () { hangUp(); });

    // Auto-connect socket for presence
    ensureSocket();
  }

  document.addEventListener("DOMContentLoaded", wireUI);
})();
