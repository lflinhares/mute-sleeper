// mutesleeper.js
// Logic for the "Mute Sleeper" Max for Live device.
// Place this file in the SAME folder as "Mute Sleeper.amxd".
//
// What it does:
//  - Finds the track this device sits on (the "host", usually a Group
//    Track) and every track inside it, nested groups included.
//  - A track counts as OFF when its own Track Activator is off, or the
//    activator of any group above it is off.
//  - On OFF tracks, every device that is on gets switched off (its
//    "Device On" parameter, i.e. parameters[0]), so Live stops processing
//    it. Muting a track alone does NOT stop plugins from using CPU.
//  - When the track is back ON, only the devices this script switched off
//    are switched back on. Devices you turned off yourself stay off.
//  - The list of sleeping devices is saved with the Live set (hidden blob
//    parameter on the [js] box, via getvalueof/setvalueof).
//  - Switching this device off (Live's device on/off button, via
//    [live.thisdevice]'s middle outlet) wakes everything it put to sleep.
//
// Live API rule: the set cannot be changed from inside an observer
// callback, so callbacks only schedule work through Tasks.
//
// Inlet 0 receives:
//   init            - from live.thisdevice (device is ready)
//   enable <0/1>    - device on/off state, from live.thisdevice
//   pluginsonly <0/1> - only sleep VST/AU plugins, leave Live devices alone
//   wakeall         - recovery: switch ON every device on tracks that are ON
//
// Outlet 0: "set ..." status text for the comment box.

inlets = 1;
outlets = 1;

autowatch = 1;

var PLUGIN_CLASSES = { PluginDevice: 1, AuPluginDevice: 1 };

var initialized = false;
var enabled = 1;
var pluginsOnly = 0;

var thisDeviceId = 0;
var thisDeviceName = "";
var hostId = 0;

var scope = [];      // track ids: host first, then descendants in song order
var parentOf = {};   // track id -> group track id (0 = none)
var slept = {};      // device id -> true, devices this script switched off
var pendingState = null; // saved state received before init

var observers = [];
var lastTracks = "";
var lastDevices = {}; // track id -> joined device id list

var applyTask = new Task(applyAll, this);
var rebuildTask = new Task(rebuild, this);

// ---------------------------------------------------------------- helpers

function api(id) {
	return new LiveAPI("id " + id);
}

// ["id", 3, "id", 7] -> [3, 7]
function ids(list) {
	var out = [];
	if (!list) return out;
	for (var i = 0; i < list.length; i++) {
		if (list[i] === "id" && i + 1 < list.length) {
			var n = parseInt(list[i + 1], 10);
			if (n > 0) out.push(n);
			i++;
		}
	}
	return out;
}

function first(list) {
	return (list && list.length) ? list[0] : null;
}

function deviceIds(trackId) {
	return ids(api(trackId).get("devices"));
}

function onParam(deviceId) {
	var params = ids(api(deviceId).get("parameters"));
	return params.length ? params[0] : 0;
}

// True if this script should manage the device at all.
function managed(deviceId) {
	if (deviceId === thisDeviceId) return false;
	var dev = api(deviceId);
	// Never touch other Mute Sleeper instances.
	if (thisDeviceName !== "" && first(dev.get("name")) === thisDeviceName) return false;
	if (pluginsOnly && !PLUGIN_CLASSES[first(dev.get("class_name"))]) return false;
	return true;
}

function isMuted(trackId) {
	var id = trackId;
	while (id) {
		if (parseInt(first(api(id).get("mute")), 10) === 1) return true;
		id = parentOf[id] || 0;
	}
	return false;
}

function setDeviceOn(deviceId, value) {
	var p = onParam(deviceId);
	if (!p) return false;
	var param = api(p);
	if (parseInt(first(param.get("value")), 10) === value) return false;
	param.set("value", value);
	return true;
}

function deviceIsOn(deviceId) {
	var p = onParam(deviceId);
	return p ? parseInt(first(api(p).get("value")), 10) === 1 : false;
}

function deviceExists(deviceId) {
	return parseInt(api(deviceId).id, 10) === deviceId;
}

function countSlept() {
	var n = 0;
	for (var k in slept) n++;
	return n;
}

function status() {
	if (!enabled) {
		outlet(0, "set", "Off");
		return;
	}
	var n = countSlept();
	outlet(0, "set", "Sleeping: " + n + (n === 1 ? " device" : " devices"));
}

// -------------------------------------------------------------- messages

function init() {
	var me = new LiveAPI("this_device");
	thisDeviceId = parseInt(me.id, 10);
	thisDeviceName = first(me.get("name")) || "";

	// Walk up from the device (it may be inside a rack) to its track.
	var p = new LiveAPI("this_device canonical_parent");
	while (p.type !== "Track" && p.type !== "Song" && parseInt(p.id, 10) > 0) {
		p = new LiveAPI(p.unquotedpath + " canonical_parent");
	}
	if (p.type !== "Track") {
		post("Mute Sleeper: could not find the track this device is on\n");
		return;
	}
	hostId = parseInt(p.id, 10);
	initialized = true;
	rebuild();
}

function enable(v) {
	enabled = v ? 1 : 0;
	if (initialized) applyTask.schedule(0);
	else status();
}

function pluginsonly(v) {
	pluginsOnly = v ? 1 : 0;
	if (initialized) applyTask.schedule(0);
}

function wakeall() {
	if (!initialized) return;
	for (var i = 0; i < scope.length; i++) {
		if (isMuted(scope[i])) continue;
		var devs = deviceIds(scope[i]);
		for (var j = 0; j < devs.length; j++) {
			if (managed(devs[j])) setDeviceOn(devs[j], 1);
			delete slept[devs[j]];
		}
	}
	saveState();
	status();
}

// ---------------------------------------------------------- scope/observe

function clearObservers() {
	for (var i = 0; i < observers.length; i++) observers[i].property = "";
	observers = [];
}

function observe(id, property, callback) {
	var o = new LiveAPI(callback, "id " + id);
	o.property = property;
	observers.push(o);
}

function rebuild() {
	if (!initialized) return;
	clearObservers();

	var song = new LiveAPI("live_set");
	var all = ids(song.get("tracks"));
	lastTracks = all.join(",");

	parentOf = {};
	for (var i = 0; i < all.length; i++) {
		var t = api(all[i]);
		var grouped = parseInt(first(t.get("is_grouped")), 10) === 1;
		parentOf[all[i]] = grouped ? (ids(t.get("group_track"))[0] || 0) : 0;
	}

	// Host first, then every track whose group chain reaches the host.
	// (A return track as host simply has no children.)
	scope = [hostId];
	for (var a = 0; a < all.length; a++) {
		var id = parentOf[all[a]];
		while (id) {
			if (id === hostId) { scope.push(all[a]); break; }
			id = parentOf[id] || 0;
		}
	}

	// Watch mute on the scope and on the groups above the host.
	var watchMute = scope.slice();
	var up = parentOf[hostId] || 0;
	while (up) { watchMute.push(up); up = parentOf[up] || 0; }
	for (var m = 0; m < watchMute.length; m++) observe(watchMute[m], "mute", onMute);

	lastDevices = {};
	for (var s = 0; s < scope.length; s++) {
		lastDevices[scope[s]] = deviceIds(scope[s]).join(",");
		observe(scope[s], "devices", onDevices);
	}
	observe(parseInt(song.id, 10), "tracks", onTracks);

	if (pendingState !== null) {
		adoptState(pendingState);
		pendingState = null;
	}
	applyAll();
}

function onMute(args) {
	if (args[0] === "mute") applyTask.schedule(0);
}

function onTracks(args) {
	if (args[0] !== "tracks") return;
	if (ids(args.slice(1)).join(",") !== lastTracks) rebuildTask.schedule(0);
}

function onDevices(args) {
	if (args[0] !== "devices") return;
	var trackId = parseInt(this.id, 10);
	if (ids(args.slice(1)).join(",") !== lastDevices[trackId]) rebuildTask.schedule(0);
}

// ----------------------------------------------------------------- apply

function applyAll() {
	if (!initialized) return;
	var seen = {};

	for (var i = 0; i < scope.length; i++) {
		var off = enabled && isMuted(scope[i]);
		var devs = deviceIds(scope[i]);
		for (var j = 0; j < devs.length; j++) {
			var d = devs[j];
			seen[d] = true;
			if (off && managed(d)) {
				if (setDeviceOn(d, 0)) slept[d] = true;
			} else if (slept[d]) {
				setDeviceOn(d, 1);
				delete slept[d];
			}
		}
	}

	// Sleeping devices that left the scope (moved or deleted): wake them.
	for (var k in slept) {
		var id = parseInt(k, 10);
		if (!seen[id]) {
			if (deviceExists(id)) setDeviceOn(id, 1);
			delete slept[k];
		}
	}

	saveState();
	status();
}

// ------------------------------------------------------------ persistence
// Saved as "trackIndex:deviceIndex,..." relative to the scope, because
// Live object ids change every time the set is loaded.

function serialize() {
	var parts = [];
	for (var i = 0; i < scope.length; i++) {
		var devs = deviceIds(scope[i]);
		for (var j = 0; j < devs.length; j++) {
			if (slept[devs[j]]) parts.push(i + ":" + j);
		}
	}
	return parts.length ? parts.join(",") : "none";
}

function adoptState(str) {
	if (!str || str === "none") return;
	var parts = String(str).split(",");
	for (var p = 0; p < parts.length; p++) {
		var ij = parts[p].split(":");
		var t = scope[parseInt(ij[0], 10)];
		if (!t) continue;
		var d = deviceIds(t)[parseInt(ij[1], 10)];
		// Only adopt devices that are still off, so nothing gets woken by
		// mistake if the set was rearranged.
		if (d && managed(d) && !deviceIsOn(d)) slept[d] = true;
	}
}

function saveState() {
	notifyclients();
}

function getvalueof() {
	if (!initialized) return pendingState !== null ? pendingState : "none";
	return serialize();
}

function setvalueof(v) {
	var str = arguments.length > 1 ? Array.prototype.join.call(arguments, " ") : String(v);
	if (initialized) {
		adoptState(str);
		applyTask.schedule(0);
	} else {
		pendingState = str;
	}
}
