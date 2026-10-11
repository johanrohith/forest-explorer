# Forest Explorer

A first-person walk through a procedurally generated 3D forest. Plain HTML + JavaScript, with
Three.js r160 **bundled locally** (`vendor/three.min.js`): no build step, no npm install, no CDN, works offline.

## Run it

Any static file server works:

    cd forest-explorer
    python3 -m http.server 8000      # then open http://localhost:8000
    # or:  npx serve .

Opening `index.html` directly (file://) also works because the scripts are classic scripts, not ES modules.
If your browser blocks something on file://, use the server above.

URL options: `?quality=low` or `?quality=high` (default is chosen automatically: low on phones/tablets),
`?touch=1` forces the touch controls on.

## Controls

| Action | Desktop | Mobile |
|---|---|---|
| Move | WASD / arrow keys | left joystick |
| Run | Shift | hold RUN |
| Look | click (locks mouse) + move mouse, or drag | drag anywhere outside the joystick |
| Pause / resume | Esc or P, or the pause button | pause button |
| Mute | M or the speaker button | speaker button |

The pause menu has Resume, Restart, a time-of-day slider, day/night cycle, shadows and sound toggles.
Follow the dirt path to find a campfire and a pond.

## Deploy

It is a static site: upload the folder as it is.

- **GitHub Pages**: push the folder to a repo, Settings > Pages > deploy from branch (`.nojekyll` is included).
- **Netlify / Cloudflare Pages / Vercel**: drag-and-drop the folder, or point at the repo. Build command: none. Publish directory: `.`
- **Any web host**: copy all files, keep the `js/` and `vendor/` folders next to `index.html`.

## Project layout

    index.html        page, HUD, touch controls, start/pause overlays, styles
    js/util.js        math/noise helpers, geometry utilities
    js/env.js         sky, sun/moon, day-night cycle, fog, clouds, lighting
    js/world.js       terrain, trees (pine/oak/birch/autumn), grass, ferns, rocks, logs, pond, campfire, path, collision
    js/audio.js       procedural ambient audio (wind, birds, crickets, water, fire, footsteps) via Web Audio
    js/main.js        renderer, first-person hand, player movement, input (keyboard/mouse/touch), UI states, game loop, adaptive resolution
    vendor/           Three.js r160 + license
    backup/           the original single-file index.html you supplied (untouched)
    FOREST_PROGRESS.md  status and resume notes

## Debug hooks

`window.FE.game` exposes `state`, `player`, `input`, `world()`, `step(dt)`, `teleport(x,z,yaw,pitch)`, `setTime(hour)`,
`pause()`, `resume()`, `restart()`, which are handy for testing from the console.
