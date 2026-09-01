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

  remindersBtn.addEventListener("click", openPanel);
  closeReminders.addEventListener("click", closePanel);
  closeRemindersBtn.addEventListener("click", closePanel);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/lista-spesa/sw.js", { scope: "/lista-spesa/" })
      .then(() => navigator.serviceWorker.ready)
      .then(() => console.log("Modalità offline pronta"))
      .catch((error) => console.error("Service Worker non registrato:", error));
  }
});
