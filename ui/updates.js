export function updateUI(data) {
  document.getElementById("cloud-value").textContent =
    data.cloudPercent !== null ? `${data.cloudPercent}%` : "--%";

  document.getElementById("night-score").textContent =
    data.nightScore ?? "--";
}