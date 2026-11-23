/** Pages for checking the watch window's script (`watch_agent.js`). */

/** A dropdown as the player at api.embf.net draws it: a head with the current one, and every item, the active one marked. */
function dropdown(items: string[], active: number): string {
  return `<div class="dropdown_2c1 hideOnMini_wxn"><div class="head_1gl bgFill_2RW"><span class="headText_3i3">${items[active]}</span><div class="icon_3fZ"><svg viewBox="0 0 14 14"><path d="M1 1"></path></svg></div></div>
    <div class="dyn_1mk"><div class="menu_2sa">${items.map((item, i) => `<div class="item_2mH${i === active ? " active_1Rh" : ""} underline_3ez">${item}</div>`).join("")}</div></div></div>`;
}

/** A page like the owner's: a site menu, the site's «Плеер 1/2/3» buttons, and a player with its seasons, episodes and dubs. */
export function page() {
  document.title = "Половое воспитание 1 сезон 1 серия";
  document.body.innerHTML = `
    <nav><ul class="menu"><li class="active"><a href="/">Главная</a></li><li><a href="/films">Фильмы</a></li><li><a href="/serials">Сериалы</a></li></ul></nav>
    <div id="Player">
      <div class="player-list"><button class="active" data-id="1">Плеер 1</button><button data-id="4">Плеер 2</button><button data-id="2">Плеер 3</button></div>
      <div class="player-box"><div class="video_9Xh"><video></video></div>
        <div class="list_5Wf">${dropdown(["1 сезон", "2 сезон", "3 сезон", "4 сезон"], 0)}${dropdown(["1 серия", "2 серия", "3 серия", "4 серия"], 0)}${dropdown(["BTi Studios", "Eng.Original"], 0)}</div>
        <select name="quality"><option>1080p</option><option selected>720p</option><option>480p</option></select>
      </div>
    </div>`;
  const video = document.querySelector("video")!;
  video.getBoundingClientRect = () => ({ width: 800, height: 450, top: 0, left: 0, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => ({}) });
  // Each item makes itself the active one when clicked, as the player does.
  for (const menu of document.querySelectorAll(".menu_2sa")) {
    for (const item of menu.children) {
      item.addEventListener("click", () => {
        for (const other of menu.children) other.classList.remove("active_1Rh");
        item.classList.add("active_1Rh");
      });
    }
  }
  for (const button of document.querySelectorAll(".player-list button")) {
    button.addEventListener("click", () => {
      for (const other of document.querySelectorAll(".player-list button")) other.classList.remove("active");
      button.classList.add("active");
    });
  }
}
