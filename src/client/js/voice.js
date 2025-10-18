"use strict";

// Minimal WebRTC voice client with Socket.IO signaling
(function () {
  var socket = null;
  var peerConnection = null;
  var localStream = null;
  var roomId = null;
  var remoteAudioEl = null;
  var localAudioEl = null;
  var isMuted = false;

  function log() {
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["[voice]"].concat(args));
  }

  function sendSignal(data) {
    if (!socket || !roomId) return;
    socket.emit("signal", { data: data, roomId: roomId });
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
      if (remoteAudioEl) {
        try { remoteAudioEl.srcObject = stream; }
        catch (e) { remoteAudioEl.src = window.URL.createObjectURL(stream); }
        remoteAudioEl.play().catch(function () { /* autoplay might need a gesture */ });
      }
    };

    if (localStream) {
      localStream.getTracks().forEach(function (track) {
        pc.addTrack(track, localStream);
      });
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
    if (!id) return;
    roomId = id;
    socket = io();

    socket.on("joined", function (info) {
      log("joined", info);
      // If there is already someone in the room, create an offer as the joiner
      if (info && info.numClients > 1) {
        makeOffer();
      }
    });

    socket.on("peer-joined", function (info) {
      log("peer-joined", info);
      // The newcomer should offer; to avoid glare, existing peers wait
    });

    socket.on("signal", onSocketSignal);

    socket.emit("join", roomId);
  }

  function leaveRoom() {
    if (socket && roomId) {
      socket.emit("leave", roomId);
    }
    if (peerConnection) { try { peerConnection.close(); } catch (e) {} peerConnection = null; }
    if (localStream) { localStream.getTracks().forEach(function (t) { t.stop(); }); localStream = null; }
    roomId = null;
  }

  function startVoice(id) {
    // Request mic on user gesture
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      .then(function (stream) {
        localStream = stream;
        if (localAudioEl) {
          try { localAudioEl.srcObject = stream; }
          catch (e) { localAudioEl.src = window.URL.createObjectURL(stream); }
        }
        createPeerConnection();
        return joinRoom(id);
      })
      .catch(function (err) {
        console.error("getUserMedia failed", err);
        alert("Microphone permission was denied or not available.");
      });
  }

  function toggleMute() {
    if (!localStream) return;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach(function (t) { t.enabled = !isMuted; });
    return isMuted;
  }

  function wireUI() {
    remoteAudioEl = document.getElementById("remoteAudio");
    localAudioEl = document.getElementById("localAudio");
    var roomInput = document.getElementById("roomId");
    var joinBtn = document.getElementById("joinBtn");
    var leaveBtn = document.getElementById("leaveBtn");
    var muteBtn = document.getElementById("muteBtn");

    if (joinBtn) {
      joinBtn.addEventListener("click", function () {
        var id = roomInput && roomInput.value ? roomInput.value.trim() : "public";
        startVoice(id);
      });
    }
    if (leaveBtn) {
      leaveBtn.addEventListener("click", function () {
        leaveRoom();
      });
    }
    if (muteBtn) {
      muteBtn.addEventListener("click", function () {
        var muted = toggleMute();
        muteBtn.innerText = muted ? "Unmute" : "Mute";
      });
    }
  }

  document.addEventListener("DOMContentLoaded", wireUI);
})();
