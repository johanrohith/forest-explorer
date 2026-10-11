<p align="center">
  <img src="assets/forest-explorer-banner.svg" alt="Forest Explorer — Follow the trail. Find what the forest hides." width="100%">
</p>

<p align="center">
  <strong>A quiet, first-person journey through a living forest.</strong><br>
  Wander winding trails, watch the light change, listen to the forest, and record discoveries along the way.
</p>

<p align="center">
  <img alt="Platform" src="https://img.shields.io/badge/platform-desktop%20%26%20mobile-285c42">
  <img alt="Rendering" src="https://img.shields.io/badge/3D-Three.js%20r160-178b69">
  <img alt="Build" src="https://img.shields.io/badge/build-static%20web%20project-466b53">
</p>

## Overview

**Forest Explorer** is a browser-based 3D exploration experience built around atmosphere, gentle movement, and environmental discovery. Its stylized forest features winding dirt paths, layered vegetation, a quiet pond, standing stones, and a campfire clearing. A changing sky and day–night cycle give familiar locations a different mood as the journey unfolds.

## Features

- **Procedural forest environment** — varied trees, ground cover, ferns, flowers, mushrooms, rocks, fallen logs, paths, and terrain.
- **Changing atmosphere** — animated sky, sun and moon, fog, lighting, shadows, wind, and a day–night cycle.
- **First-person exploration** — keyboard and mouse support on desktop, plus touch controls for mobile screens.
- **Ambient soundscape** — procedural wind, leaves, birds, night insects, water, campfire ambience, and movement sounds.
- **Field journal** — discover and record four locations: the campfire, pond, standing stones, and a ranger waystone.
- **Quick-access settings** — pause and resume, restart, sound controls, time-of-day controls, and shadow settings.
- **Mobile-aware rendering** — quality settings adapt to device characteristics, with a manual quality option available through the URL.

## Controls

| Action | Desktop | Mobile |
| --- | --- | --- |
| Move | `W` `A` `S` `D` or arrow keys | Left virtual joystick |
| Run | Hold `Shift` | Hold **RUN** |
| Look around | Mouse movement or drag | Drag the gameplay view |
| Examine a discovery | `E` or on-screen button | On-screen **EXAMINE** button |
| Open field journal | `J` or journal button | Journal button |
| Pause / resume | `Esc` or pause button | Pause button |

## Project structure

```text
forest-explorer/
├── index.html                     # Page structure and game interface
├── style.css                      # HUD, menus, overlays, and touch controls
├── assets/
│   └── forest-explorer-banner.svg # Project banner
├── js/
│   ├── main.js                    # Renderer, player, input, HUD, game loop
│   ├── world.js                   # Terrain, vegetation, props, collisions
│   ├── env.js                     # Sky, lighting, fog, day/night cycle
│   ├── audio.js                   # Ambient audio and footsteps
│   └── util.js                    # Shared math, geometry, noise, and wind helpers
└── vendor/
    ├── three.min.js               # Three.js r160 runtime
    └── THREE-LICENSE.txt          # Third-party license
```

<p align="center"><sub>Forest Explorer · A small world made for taking the longer way around.</sub></p>
