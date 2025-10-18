(function(){
  "use strict";

  // Simple in-memory store with localStorage persistence
  const STORAGE_KEY = "call_contact_manager_state_v1";
  const defaultState = {
    friends: [], // { id, phone }
    groups: [],  // { id, name, memberIds: [] }
    log: []      // { id, phone, timestamp, status: 'answered'|'no-answer' }
  };

  /** @type {typeof defaultState} */
  let state = loadState();

  function loadState(){
    try{
      const raw = localStorage.getItem(STORAGE_KEY);
      if(!raw) return { ...defaultState };
      const parsed = JSON.parse(raw);
      return {
        friends: Array.isArray(parsed.friends) ? parsed.friends : [],
        groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        log: Array.isArray(parsed.log) ? parsed.log : []
      };
    }catch(e){
      console.warn("Failed to load state, using defaults", e);
      return { ...defaultState };
    }
  }

  function saveState(){
    try{
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }catch(e){
      console.warn("Failed to persist state", e);
    }
  }

  function uid(){
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  // DOM helpers
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  function el(tag, attrs = {}, children = []){
    const node = document.createElement(tag);
    for(const [k,v] of Object.entries(attrs)){
      if(k === "class") node.className = v;
      else if(k === "text") node.textContent = v;
      else node.setAttribute(k, v);
    }
    for(const child of children){
      if(typeof child === "string") node.appendChild(document.createTextNode(child));
      else if(child) node.appendChild(child);
    }
    return node;
  }

  // Tabs
  function setupTabs(){
    const buttons = $$(".tab-btn");
    buttons.forEach(btn => btn.addEventListener("click", () => {
      buttons.forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const tab = btn.getAttribute("data-tab");
      ["phone","friends","messages","groups"].forEach(name => {
        const isActive = name === tab;
        const panel = $(`#tab-${name}`);
        if(panel){ panel.hidden = !isActive; }
      });
      // refresh content when switching to certain tabs
      if(tab === "friends") renderFriends();
      if(tab === "messages") renderLog();
      if(tab === "groups") { renderGroups(); refreshAssignSelectors(); }
    }));
  }

  // Phone tab behavior
  function setupPhone(){
    const input = $("#phone-input");
    const callBtn = $("#call-btn");
    const clearBtn = $("#clear-input-btn");
    const panel = $("#call-panel");
    const status = $("#call-status");
    const answerBtn = $("#answer-btn");
    const noanswerBtn = $("#noanswer-btn");
    const friendBtn = $("#friend-btn");

    let currentCallNumber = null;

    callBtn.addEventListener("click", () => {
      const phone = (input.value || "").trim();
      if(!phone){
        input.focus();
        return;
      }
      currentCallNumber = phone;
      panel.style.display = "grid";
      status.textContent = `Calling ${phone}...`;
      friendBtn.style.display = "none"; // show only on answered
    });

    clearBtn.addEventListener("click", () => {
      input.value = "";
      panel.style.display = "none";
      status.textContent = "Idle";
      currentCallNumber = null;
    });

    answerBtn.addEventListener("click", () => {
      if(!currentCallNumber) return;
      status.textContent = `Answered by ${currentCallNumber}`;
      logCall(currentCallNumber, "answered");
      friendBtn.style.display = "inline-block";
      renderLog();
    });

    noanswerBtn.addEventListener("click", () => {
      if(!currentCallNumber) return;
      status.textContent = `Did not answer (${currentCallNumber})`;
      logCall(currentCallNumber, "no-answer");
      friendBtn.style.display = "none";
      renderLog();
    });

    friendBtn.addEventListener("click", () => {
      if(!currentCallNumber) return;
      addFriend(currentCallNumber);
      renderFriends();
      refreshAssignSelectors();
      friendBtn.style.display = "none";
    });
  }

  // State operations
  function logCall(phone, status){
    state.log.unshift({ id: uid(), phone, timestamp: Date.now(), status });
    saveState();
  }

  function addFriend(phone){
    const exists = state.friends.some(f => f.phone === phone);
    if(exists) return;
    state.friends.push({ id: uid(), phone });
    saveState();
  }

  function ensureGroup(name){
    const byName = state.groups.find(g => g.name.toLowerCase() === name.toLowerCase());
    if(byName) return byName;
    const group = { id: uid(), name, memberIds: [] };
    state.groups.push(group);
    saveState();
    return group;
  }

  function assignFriendToGroup(friendId, groupId){
    const group = state.groups.find(g => g.id === groupId);
    if(!group) return;
    if(!group.memberIds.includes(friendId)){
      group.memberIds.push(friendId);
      saveState();
    }
  }

  // Renderers
  function renderFriends(){
    const container = $("#friends-list");
    container.innerHTML = "";
    if(state.friends.length === 0){
      container.appendChild(el("div", { class: "empty" , text: "No friends yet." }));
      return;
    }
    for(const friend of state.friends){
      const groups = state.groups.filter(g => g.memberIds.includes(friend.id));
      container.appendChild(
        el("div", { class: "list-item" }, [
          el("div", {}, [
            el("div", { class: "muted" , text: "Phone" }),
            el("div", { text: friend.phone })
          ]),
          el("div", {}, groups.map(g => el("span", { class: "pill", text: g.name })))
        ])
      );
    }
  }

  function renderLog(){
    const container = $("#log-list");
    container.innerHTML = "";
    if(state.log.length === 0){
      container.appendChild(el("div", { class: "empty", text: "No calls yet." }));
      return;
    }
    for(const item of state.log){
      const ts = new Date(item.timestamp).toLocaleString();
      const color = item.status === "answered" ? "#16a34a" : "#dc2626";
      container.appendChild(
        el("div", { class: "list-item" }, [
          el("div", {}, [
            el("div", { class: "muted", text: ts }),
            el("div", { text: `${item.phone}` })
          ]),
          el("span", { class: "pill", style: `border-color:${color}; color:${color};`, text: item.status })
        ])
      );
    }
  }

  function refreshAssignSelectors(){
    const friendSelect = $("#group-friend-select");
    const groupSelect = $("#group-select");
    friendSelect.innerHTML = "";
    groupSelect.innerHTML = "";

    if(state.friends.length === 0){
      friendSelect.appendChild(el("option", { value: "", text: "No friends" }));
    } else {
      for(const f of state.friends){
        friendSelect.appendChild(el("option", { value: f.id, text: f.phone }));
      }
    }
    if(state.groups.length === 0){
      groupSelect.appendChild(el("option", { value: "", text: "No groups" }));
    } else {
      for(const g of state.groups){
        groupSelect.appendChild(el("option", { value: g.id, text: g.name }));
      }
    }
  }

  function renderGroups(){
    const container = $("#groups-list");
    container.innerHTML = "";
    if(state.groups.length === 0){
      container.appendChild(el("div", { class: "empty", text: "No groups yet." }));
      return;
    }
    for(const group of state.groups){
      const members = state.friends.filter(f => group.memberIds.includes(f.id));
      container.appendChild(
        el("div", { class: "list-item" }, [
          el("div", {}, [
            el("div", { class: "muted", text: "Group" }),
            el("div", { text: group.name })
          ]),
          el("div", {}, members.length ? members.map(m => el("span", { class: "pill", text: m.phone })) : [el("span", { class: "pill", text: "No members" })])
        ])
      );
    }
  }

  // Groups tab behavior
  function setupGroups(){
    const createBtn = $("#create-group-btn");
    const nameInput = $("#group-name-input");
    const assignBtn = $("#assign-group-btn");
    const friendSelect = $("#group-friend-select");
    const groupSelect = $("#group-select");

    createBtn.addEventListener("click", () => {
      const name = (nameInput.value || "").trim();
      if(!name){ nameInput.focus(); return; }
      ensureGroup(name);
      nameInput.value = "";
      renderGroups();
      refreshAssignSelectors();
    });

    assignBtn.addEventListener("click", () => {
      const fid = friendSelect.value;
      const gid = groupSelect.value;
      if(!fid || !gid) return;
      assignFriendToGroup(fid, gid);
      renderGroups();
      renderFriends();
    });
  }

  // Init
  function init(){
    setupTabs();
    setupPhone();
    setupGroups();
    renderFriends();
    renderLog();
    renderGroups();
    refreshAssignSelectors();
  }

  if(document.readyState === "loading"){
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
