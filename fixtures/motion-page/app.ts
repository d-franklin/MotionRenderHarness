import { animate } from "motion";

// The hybrid animate() from "motion" keeps its animations in JavaScript, so the
// timeline can be scrubbed to an absolute time instead of played.
//
// The page contract with the renderer is window.seek(t) taking seconds, and
// window.__ready once the page can be driven.
const timeline = animate([
  ["#title", { opacity: [0, 1], y: [28, 0] }, { duration: 0.7 }],
  ["#l1", { opacity: [0, 1], x: [-18, 0] }, { duration: 0.5, at: "+0" }],
  ["#l2", { opacity: [0, 1], x: [-18, 0] }, { duration: 0.5, at: "+0" }],
  ["#l3", { opacity: [0, 1], x: [-18, 0] }, { duration: 0.5, at: "+0" }],
]);

// Pausing matters: an animation that keeps playing on the browser's clock
// moves between the seek and the capture, so the frame that lands on disk
// depends on how fast the machine is. A paused timeline only moves when the
// page is told to.
timeline.pause();

window.seek = (t: number) => {
  timeline.time = t;
};

document.fonts.ready.then(() => {
  window.__ready = true;
});
