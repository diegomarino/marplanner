// Marplanner landing page: theme toggle, accessible tabs and copy buttons. No dependencies.

const THEME_KEY = "mp-site-theme";
const root = document.documentElement;

function currentTheme() {
  if (root.dataset.theme) return root.dataset.theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable: the choice lasts for this page view only.
  }
});

// Tabs, following the WAI-ARIA tabs pattern with automatic activation.
for (const tabs of document.querySelectorAll("[data-tabs]")) {
  const tabList = [...tabs.querySelectorAll('[role="tab"]')];
  const select = (tab) => {
    for (const other of tabList) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      document.getElementById(other.getAttribute("aria-controls")).hidden = !selected;
    }
    tab.focus();
  };
  for (const [index, tab] of tabList.entries()) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const moves = { ArrowRight: 1, ArrowLeft: -1 };
      if (event.key in moves) {
        select(tabList[(index + moves[event.key] + tabList.length) % tabList.length]);
      } else if (event.key === "Home") {
        select(tabList[0]);
      } else if (event.key === "End") {
        select(tabList[tabList.length - 1]);
      } else {
        return;
      }
      event.preventDefault();
    });
  }
}

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const text = button.parentElement.querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Press ⌘C";
      const range = document.createRange();
      range.selectNodeContents(button.parentElement.querySelector("code"));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1800);
  });
}
