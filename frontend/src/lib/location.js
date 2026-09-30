function locationError(error) {
  if (error?.code === 1)
    return new Error(
      "Location access is blocked. Allow precise location for this site in browser settings.",
    );
  if (error?.code === 2)
    return new Error(
      "Your device could not obtain a GPS position. Turn on device Location and Wi-Fi, then move near a window and retry.",
    );
  if (error?.code === 3)
    return new Error(
      "Location was allowed, but the GPS reading timed out. Keep Location enabled and retry near a window.",
    );
  return new Error("A reliable location could not be obtained.");
}

export async function getReliableLocation({
  targetAccuracy = 50,
  maximumAccuracy = 120,
  timeout = 25000,
} = {}) {
  if (!navigator.geolocation)
    throw new Error("This browser does not support location services.");
  if (navigator.permissions?.query) {
    const permission = await navigator.permissions
      .query({ name: "geolocation" })
      .catch(() => null);
    if (permission?.state === "denied")
      throw new Error(
        "Location access is blocked. Allow precise location for this site in browser settings.",
      );
  }
  return new Promise((resolve, reject) => {
    let best = null,
      finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      navigator.geolocation.clearWatch(watchId);
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibilityChanged);
      if (best && best.accuracy <= maximumAccuracy) resolve(best);
      else
        reject(
          error ||
            new Error(
              best
                ? `Location permission is granted, but accuracy is only ±${Math.round(best.accuracy)} m. Enable precise/high-accuracy location, Wi-Fi, and GPS, then retry.`
                : "No location reading was received.",
            ),
        );
    };
    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const reading = {
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
          capturedAt: position.timestamp,
        };
        if (!best || reading.accuracy < best.accuracy) best = reading;
        if (reading.accuracy <= targetAccuracy) finish();
      },
      (error) => finish(locationError(error)),
      { enableHighAccuracy: true, maximumAge: 0, timeout },
    );
    const visibilityChanged = () => {
      if (document.hidden)
        finish(
          new Error(
            "Location verification was cancelled because you left this tab. Return here and start the check again.",
          ),
        );
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    const timer = setTimeout(() => finish(), timeout);
  });
}
