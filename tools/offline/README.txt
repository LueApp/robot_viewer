ROBOT VIEWER — OFFLINE TEST

1. Extract the entire ZIP to a local folder.
2. On Linux, open a terminal in that folder and run: sh start.sh
3. Keep the terminal open. The launcher opens http://127.0.0.1:43821/.
   If the browser does not open, paste that address into Chrome or Edge.
4. Stop the viewer with Ctrl+C in the terminal.

The Linux x64 package includes Node.js. No npm install, build, download or
internet connection is needed on the test machine. It requires a compatible
Linux x64 system with glibc and libstdc++, plus a WebGL2-capable browser.
The source package requires an existing Node.js 18+ installation; use
start.bat on Windows or sh start.sh on Linux/macOS.
Do not open web/index.html directly: USD and WebAssembly need the local server.
If the port is busy, use: sh start.sh --port=43822

PLEASE TEST

- Disconnect Wi-Fi/Ethernet and launch the viewer.
- Drop samples/joint-zero-demo.urdf into the window. Move its joints.
- Drop the entire samples folder and select urdf-transform-demo.urdf to
  check local OBJ meshes. All referenced assets must be supplied locally.
- Load offline-demo.xacro, offline-demo.xml (MJCF) and offline-demo.usda.
- For MJCF, start/pause physics. For USD, check that the blue cube is visible.
- Load one of your own robot folders. Try editing, pose export and animation.
- Close the browser and stop/restart the launcher while still disconnected.
- Report your OS/browser, file format, failed action and any displayed error.

OFFLINE BEHAVIOR

The server listens only on 127.0.0.1 and only serves the packaged web files.
It has no upload endpoint. Model files are read in the browser. Browser policy
blocks external scripts, images, asset requests and WebSocket connections.
Live simulation connections and website links are disabled in this test.
Saved recordings can still be imported and replayed. Animation autosave uses
this browser's local storage; export projects before changing browser or port.
The package includes the USD engine, worker, data, HDR and Three.js modules.

These restrictions apply to the viewer, not to other tabs, browser extensions
or operating-system services. Keep the machine disconnected if you need to
test with no external network connectivity at all.

This ZIP is a local test build with USD support. The website's offline download
is the simpler standalone HTML edition, which excludes USD.
Licenses and dependency notices are included.
