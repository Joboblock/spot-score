
# Spot-Score Project

## How to Run the Project

1. **Add your Netatmo API key:**
	- Create a file named `api-key.js` inside the `src` folder.
	- Add the following code, replacing `<Token Here>` with your actual Netatmo API access token:

	```js
	const ACCESS_TOKEN = "<Token Here>";
	export { ACCESS_TOKEN };
	```

2. **Start the local server:**
	- In your project root, run:

	```sh
	node .vscode/launch-server-and-open.js
	```

3. **Open your browser:**
	- Visit [http://localhost:8800](http://localhost:8800) to view the app.

---
If you have any issues, make sure you have Node.js installed and your API key is correct.

## Data sources

- Netatmo public weather stations (requires API key in `src/api-key.js`)
- Open-Meteo city averages
- Hamburg road traffic noise data
- Sensor.Community air quality (PM2.5/PM10)
- OpenStreetMap