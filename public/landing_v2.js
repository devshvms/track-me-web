(() => {
  const status = document.getElementById("site-status");
  const tabButtons = Array.from(document.querySelectorAll('[role="tab"][data-target]'));
  const tabPanels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

  function announce(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = false;
    window.clearTimeout(announce.timer);
    announce.timer = window.setTimeout(() => {
      status.hidden = true;
    }, 6000);
  }

  function activateTab(button, moveFocus = false) {
    const target = document.getElementById(button.dataset.target || "");
    if (!target) return;

    tabButtons.forEach((candidate) => {
      const selected = candidate === button;
      candidate.classList.toggle("active", selected);
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
    });
    tabPanels.forEach((panel) => {
      const selected = panel === target;
      panel.classList.toggle("active", selected);
      panel.hidden = !selected;
    });
    if (moveFocus) button.focus();
  }

  tabButtons.forEach((button, index) => {
    button.addEventListener("click", () => activateTab(button));
    button.addEventListener("keydown", (event) => {
      let nextIndex = null;
      if (event.key === "ArrowRight") nextIndex = (index + 1) % tabButtons.length;
      if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabButtons.length) % tabButtons.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = tabButtons.length - 1;
      if (nextIndex === null) return;
      event.preventDefault();
      activateTab(tabButtons[nextIndex], true);
    });
  });

  const initiallySelected = tabButtons.find((button) => button.getAttribute("aria-selected") === "true");
  if (initiallySelected) activateTab(initiallySelected);

  document.querySelectorAll(".release-header").forEach((header, index) => {
    const card = header.closest(".release-card");
    const body = card?.querySelector(".release-body");
    if (!card || !body) return;

    const bodyId = `release-details-${index + 1}`;
    body.id = bodyId;
    header.setAttribute("aria-controls", bodyId);

    header.addEventListener("click", () => {
      const history = card.closest(".release-history");
      const wasActive = card.classList.contains("active");
      history?.querySelectorAll(".release-card").forEach((candidate) => {
        candidate.classList.remove("active");
        candidate.querySelector(".release-header")?.setAttribute("aria-expanded", "false");
      });
      if (!wasActive) {
        card.classList.add("active");
        header.setAttribute("aria-expanded", "true");
      }
    });
  });

  [document.getElementById("auth-button"), document.getElementById("account-sign-in")]
    .filter(Boolean)
    .forEach((button) => {
      button.addEventListener("click", () => {
        window.setTimeout(() => {
          if (!window.__TRACKME_AUTH_READY__) {
            announce("Sign-in could not start. Check your connection and try again; the rest of this page remains available.");
          }
        }, 0);
      });
    });
})();
