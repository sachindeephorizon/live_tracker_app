import * as TaskManager from 'expo-task-manager';
import * as SecureStore from 'expo-secure-store';
import { BACKGROUND_TASK, STORAGE_KEY, BACKEND_URL } from '../config/constants';
import { KalmanFilter2D } from '../utils/KalmanFilter2D';
import { processLocation, SlidingWindow } from '../utils/processLocation';

const APP_STATE_KEY = 'tracking_app_state';
 const BG_GAP_RESET_MS = 60000;
// Background state — managed exclusively by the background task.
// Foreground must NEVER overwrite these.
let bgPrev = null;
const bgKalman = new KalmanFilter2D();
const bgWindow = new SlidingWindow();

export const resetBackgroundState = () => {
  bgPrev = null;
  bgKalman.reset();
  bgWindow.reset();
};

TaskManager.defineTask(BACKGROUND_TASK, async ({ data, error }) => {
  if (error || !data) return;

  try {
    const userId = await SecureStore.getItemAsync(STORAGE_KEY);
    const appState = await SecureStore.getItemAsync(APP_STATE_KEY);
    const locations = data.locations??[];

    // Skip if no user, no location, or foreground is already handling it
    if (!userId || locations.length === 0 || appState === 'foreground') return;
   for(const loc of locations){
    if(bgPrev){
      const timeGap = loc.timestamp - bgPrev.timestamp;
      if(timeGap > BG_GAP_RESET_MS){
        resetBackgroundState();
      }
    }
    const result = processLocation(loc, bgPrev, bgKalman, false, bgWindow);
    if (!result) continue;

    bgPrev = {
      latitude: result.latitude,
      longitude: result.longitude,
      timestamp: result.timestamp,
    };

    // Abort fetch if it hangs — prevents OS from killing the task
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    try {
      await fetch(`${BACKEND_URL}/${userId}/ping`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: result.latitude,
          lng: result.longitude,
          speed: result.speed,
          accuracy: result.accuracy,
          timestamp: result.timestamp,
        }),
        signal: controller.signal,
      });
    } catch {
      // Network error or aborted — next task run will retry
    } finally {
      clearTimeout(timeout);
    }
  }
  } catch (err) {
    console.error('Background sync failed:', err);
  }
});