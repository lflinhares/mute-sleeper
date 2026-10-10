# Mute Sleeper

A Max for Live audio effect for Ableton Live that saves CPU by switching off
the devices on muted tracks.

In Live, turning a track off with its Track Activator does **not** stop its
plugins from processing. A set with one heavy amp sim per song keeps every
instance running, even on muted groups. Mute Sleeper switches those devices
off while the track is off, and back on when it is on again.

## Install

Keep `Mute Sleeper.amxd` and `mutesleeper.js` in the same folder, inside your
User Library (for example `Presets/Audio Effects/Max Audio Effect/mute-sleeper`).

## Use

Put **Mute Sleeper** on a group track. It covers the group and every track
inside it, nested groups included.

- A track counts as off when its own activator is off, or the activator of
  any group above it is off.
- On tracks that are off, every device that is on gets switched off (racks
  switch off together with their contents).
- When the track is on again, only the devices Mute Sleeper switched off are
  switched back on. Devices you turned off yourself stay off.
- The list of sleeping devices is saved with the Live set (up to 32 devices
  per instance, counted across the tracks it covers).

Controls:

- **Plugins only**: only switch off VST/AU plugins, leave Live's own devices
  alone.
- **Wake all**: recovery button. Switches on every device on tracks that are
  on, including devices you turned off on purpose.
- Switching Mute Sleeper itself off wakes everything it put to sleep. Do this
  before deleting the device.

## Notes

- Every device switch appears in Live's undo history.
- If a track inside the group sends its output somewhere other than the group
  (for example straight to Master), muting the group does not silence it, but
  its devices are still switched off, so you hear it unprocessed.
- Other Mute Sleeper instances are never switched off.
