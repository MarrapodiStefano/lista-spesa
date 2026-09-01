// Registra subito il Service Worker: la web app deve poter partire anche senza rete.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js")
    .then(() => navigator.serviceWorker.ready)
    .then(() => console.log("Modalità offline pronta"))
    .catch((error) => console.error("Service Worker non registrato:", error));
}

document.addEventListener("DOMContentLoaded", () => {
  const remindersBtn = document.getElementById("remindersBtn");
  const remindersPanel = document.getElementById("remindersPanel");
  const closeReminders = document.getElementById("closeReminders");
  const closeRemindersBtn = document.getElementById("closeRemindersBtn");

  const openPanel = () => {
    remindersPanel.classList.add("is-open");
    remindersPanel.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  };

  const closePanel = () => {
    remindersPanel.classList.remove("is-open");
    remindersPanel.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
  };

  if (remindersBtn) remindersBtn.addEventListener("click", openPanel);
  if (closeReminders) closeReminders.addEventListener("click", closePanel);
  if (closeRemindersBtn) closeRemindersBtn.addEventListener("click", closePanel);
});
