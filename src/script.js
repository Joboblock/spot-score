import { API_KEY } from "../api-key.js";

document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("searchBtn");
    if (btn) btn.addEventListener("click", getWeather);
});
async function getWeather() {
    const city = document.getElementById("cityInput").value;
    const output = document.getElementById("output");

    if (!city) {
        output.innerHTML = "<div class='error'>Enter a city.</div>";
        return;
    }

    output.innerHTML = "<div class='loading'>Loading...</div>";

    try {
        const response = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}`
        );

        if (!response.ok) {
            throw new Error("City not found");
        }

        const data = await response.json();

        output.innerHTML = `
            <h3>${data.name}</h3>
            <p><strong>${data.weather[0].main}</strong></p>
            <p>🌡 Temp: ${data.main.temp} °C</p>
            <p>💧 Humidity: ${data.main.humidity}%</p>
        `;

    } catch (error) {
        output.innerHTML = `<div class='error'>${error.message}</div>`;
    }
}

// Expose getWeather to global scope for onclick
window.getWeather = getWeather;
