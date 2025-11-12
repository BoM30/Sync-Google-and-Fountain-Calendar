/**
 * =====================================================================================
 * Fountain Proactive Slot Creator (v11.4 - Hybrid Sync + "Busy is Busy" Logic)
 * =====================================================================================
 *
 * Description: This script proactively creates and deletes interview slots in Fountain
 * to ensure the schedule is a perfect reflection of a recruiter's Google Calendar.
 *
 * NEW in v11.4 ("Busy is Busy"):
 * - Simplified `findConflictingSlots` logic.
 * - If an UNBOOKED Fountain slot overlaps with ANY busy Google Calendar event,
 * it is now correctly flagged for deletion.
 * - This fixes the bug where unbooked slots were being "protected" because
 * they overlapped with a GCal event from a *different* (e.g., manual) booking.
 *
 * NEW in v11.3 (ID Fix):
 * - [REVERTED] Updated `createFountainSlots` to use `user_id` (Fountain ID) instead of
 * `recruiter_email` for slot creation.
 * - [REVERTED] Updated 404 diagnostic logic.
 *
 * NEW in v11.0 (Hybrid Sync):
 * - Implements a "Full Sync" and "Delta Sync" model for massive efficiency gains.
 * - `syncCalendars_Full`: Runs ONCE nightly during Quiet Hours as a master reset.
 * - `syncCalendars_Delta`: Runs frequently (e.g., every 15 mins) outside Quiet Hours,
 * only actioning changes (deltas) from the cached state.
 *
 * =====================================================================================
 */

// Global variable for the script's configured logging level.
let SCRIPT_LOG_LEVEL;
// Global counter for API calls
let urlFetchCounter = 0;

/**
 * Custom logging function to control verbosity based on Script Properties.
 * @param {string} message The message to log.
 * @param {string} level The level of this message ('NORMAL' or 'DEBUG').
*/
function log(message, level) {
  if (SCRIPT_LOG_LEVEL === 'NONE') return;

  if (SCRIPT_LOG_LEVEL === 'DEBUG') {
    Logger.log(message); // Log everything in DEBUG mode
  } else if (SCRIPT_LOG_LEVEL === 'NORMAL' && level === 'NORMAL') {
    Logger.log(message); // Only log NORMAL messages in NORMAL mode
  }
}

/**
 * [HELPER FUNCTION]
 * A wrapper for UrlFetchApp.fetch() that counts every call.
 * @param {string} url The URL to fetch.
 * @param {object} options The options for the fetch call.
 * @return {GoogleAppsScript.URL_Fetch.HTTPResponse} The HTTP response.
 */
function fetchWithCounting(url, options) {
  urlFetchCounter++;
  log(' -> Making UrlFetch call #' + urlFetchCounter + ' to: ' + url.substring(0, 120) + '...', 'DEBUG');
  try {
      return UrlFetchApp.fetch(url, options);
  } catch (e) {
    log('❌ URLFetch Error for call #' + urlFetchCounter + ': ' + e.toString(), 'NORMAL');
    // Return a dummy response object on error to avoid breaking loops
    // that expect a response object. Check response code later.
    return {
      getResponseCode: function() { return 500; }, // Simulate an error code
      getContentText: function() { return 'URLFetch failed: ' + e.toString(); }
    };
  }
}


/**
 * [SETUP FUNCTION]
 * Run this function ONCE to configure the script's global properties.
 */
function setupScriptProperties() {
  const properties = {
    // --- REQUIRED: FILL THESE VALUES ---
    'FOUNTAIN_API_KEY': 'YOUR_FOUNTAIN_API_KEY_HERE',
    'GOOGLE_SHEET_ID': 'YOUR_GOOGLE_SHEET_ID_HERE',

    /**
     * Number of days in the future to create slots for, in addition to today.
     */
    'DAYS_TO_SYNC_IN_FUTURE': '7',

    /**
     * Controls the level of detail in the logs.
     * 'NONE', 'NORMAL' (default), 'DEBUG'.
     */
    'LOGGING_LEVEL': 'NORMAL',

    /**
     * The service account email used by the Fountain system to create events.
     * Found using the investigateEventOrganizers() tool.
     */
    'FOUNTAIN_ORGANIZER_EMAIL': 'c_df21b1df47db36b83443adc10ef622a03d7182f3019b148647568cfdd84446f3@group.calendar.google.com',

    /**
     * NEW v10.7: Quiet Hours Start (24-hour format, e.g., 22 for 10 PM)
     */
    'QUIET_HOURS_START': '22',

    /**
     * NEW v10.7: Quiet Hours End (24-hour format, e.g., 6 for 6 AM)
     */
    'QUIET_HOURS_END': '6',

    /**
     * NEW v11.0: Override for Full Sync
     * Set to 'true' to allow syncCalendars_Full to run *outside* of quiet hours.
     * WARNING: Set back to 'false' for normal operation.
     */
    'OVERRIDE_QUIET_HOURS_FULL_SYNC': 'false',
   
    /**
     * NEW v12.0: Recruiter Batch Size
     * Number of recruiters to process in a single execution of syncCalendars_Full.
     */
    'RECRUITER_BATCH_SIZE': '10',

    /**
     * NEW v12.1: Trigger Schedule Configuration
     */
    'TRIGGER_START_HOUR': '1', // The hour (0-23) to start the first trigger.
    'TRIGGER_INTERVAL_MINUTES': '15', // The number of minutes between triggers.
    'TRIGGER_COUNT': '10' // The total number of triggers to create.
  };

  try {
    PropertiesService.getScriptProperties().setProperties(properties);
    Logger.log('✅ Script properties have been successfully set. LOGGING_LEVEL is set to ' + properties.LOGGING_LEVEL);
    Logger.log('✅ Quiet Hours set from ' + properties.QUIET_HOURS_START + ':00 to ' + properties.QUIET_HOURS_END + ':00.');
    Logger.log('✅ Full Sync Quiet Hours Override is set to: ' + properties.OVERRIDE_QUIET_HOURS_FULL_SYNC);
  } catch (e) {
    Logger.log('❌ Failed to set script properties. Error: ' + e.toString());
  }
}

/**
 * [MAIN AUTOMATED FUNCTION - REFACTORED v11.0]
 * This is the NIGHTLY FULL SYNC. It runs ONCE during quiet hours.
*/
function syncCalendars_Full() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();

  SCRIPT_LOG_LEVEL = config.LOGGING_LEVEL || 'NORMAL';
  urlFetchCounter = 0; // Reset API call counter

  // --- v12.2: Locking Mechanism ---
  const lock = LockService.getScriptLock();
  // Wait for up to 10 seconds for the lock.
  if (!lock.tryLock(10000)) {
    log('⚠️ Skipping execution: An existing sync is still in progress.', 'NORMAL');
    return;
  }
  // --- End Locking Mechanism ---

  try {
  // --- v11.0: Quiet Hours Check (with Override) ---
  const overrideQuietHours = config.OVERRIDE_QUIET_HOURS_FULL_SYNC === 'true';

  if (overrideQuietHours) {
    log('⚠️ Quiet Hours check for FULL SYNC is being overridden by script property. Running sync now...', 'NORMAL');
  } else {
    // This FULL sync should ONLY run *DURING* quiet hours.
    const quietStart = parseInt(config.QUIET_HOURS_START || '22', 10);
    const quietEnd = parseInt(config.QUIET_HOURS_END || '6', 10);
    const currentHour = parseInt(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'), 10);

    let isQuietTime = false;
    if (quietStart < quietEnd) { // Normal same-day range (e.g., 9 to 17)
      isQuietTime = currentHour >= quietStart && currentHour < quietEnd;
    } else { // Overnight range (e.g., 22 to 6)
      isQuietTime = currentHour >= quietStart || currentHour < quietEnd;
    }

    if (!isQuietTime) {
      log('Current hour (' + currentHour + ') is outside Quiet Hours (' + quietStart + '-' + quietEnd + '). Skipping NIGHTLY FULL SYNC.', 'NORMAL');
      return; // Exit script early
    }
  }
  // --- End Quiet Hours Check ---

  log('🚀 Starting NIGHTLY FULL SYNC (v12.0)...', 'NORMAL');
 
  const allFlatRecruiterConfigs = loadRecruiterConfig(config.GOOGLE_SHEET_ID);
  if (!allFlatRecruiterConfigs || allFlatRecruiterConfigs.length === 0) {
    log('🛑 Halting execution: No valid recruiter configurations found in the Google Sheet.', 'NORMAL');
    return;
  }

  // --- v12.0: Batch Processing Logic ---
  const { currentBatch, totalBatches, recruiterEmailsForBatch } = getNextRecruiterBatch(config, allFlatRecruiterConfigs);
  if (recruiterEmailsForBatch.length === 0 && totalBatches > 0) {
    log('✅ All recruiter batches have been processed. Nightly sync is complete until the next cycle.', 'NORMAL');
    return; // Exit if all batches are done
  }
  log('Processing Recruiter Batch ' + currentBatch + ' of ' + totalBatches + ' (' + recruiterEmailsForBatch.length + ' recruiters).', 'NORMAL');
  // --- End Batch Processing Logic ---


  if (!config.GOOGLE_SHEET_ID || config.GOOGLE_SHEET_ID.includes('YOUR_')) {
    log('🛑 ERROR: GOOGLE_SHEET_ID is not configured. Please run setupScriptProperties.', 'NORMAL');
    return;
  }

  if (typeof Calendar === 'undefined') {
    log('🛑 ERROR: The Advanced Google Calendar API service is not enabled. Please enable it in the script editor under "Services".', 'NORMAL');
    return;
  }

  log('🚀 Starting Proactive Fountain Calendar Sync...', 'NORMAL');
 
  // v12.0: Filter all configs down to just the ones in the current batch
  const recruiterEmailSet = new Set(recruiterEmailsForBatch);
  const flatRecruiterConfigs = allFlatRecruiterConfigs.filter(c => recruiterEmailSet.has(c.email));

  // v12.0: Group only the batch recruiters
  const groupedConfigs = groupConfigsByRecruiter(flatRecruiterConfigs);
 
  // v12.0: If, after filtering, there are no recruiters to process for this batch, exit.
  if (Object.keys(groupedConfigs).length === 0) {
     log('No recruiters found for the current batch. Exiting.', 'NORMAL');
     return;
  }
  const daysToSync = parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let allRecruiterEvents = {}; // <-- v11.0: Store this for cache priming

  try {
    const syncStartDate = new Date(today);
    const syncEndDate = new Date(today);
    syncEndDate.setDate(today.getDate() + daysToSync);
    syncEndDate.setHours(23, 59, 59, 999);

    // --- v10.6: Get all recruiter calendar events ONCE ---
    for (const email in groupedConfigs) {
      log('Fetching Google Calendar events for: ' + email, 'NORMAL');
      const events = getBusyCalendarEvents(email, syncStartDate, syncEndDate);
      allRecruiterEvents[email] = events;
      log('Found ' + events.length + ' total busy Google Calendar events for ' + email, 'NORMAL');
    }

    // --- v10.6: Get all UNIQUE stage IDs ONCE ---
    const uniqueStageIds = [...new Set(flatRecruiterConfigs.map(function(c) { return c.stageId; }))];
    log('Found ' + uniqueStageIds.length + ' unique stage(s) across all recruiters.', 'NORMAL');

    // --- v10.6: Loop by DAY first ---
    for (let i = 0; i <= daysToSync; i++) {
      const currentDate = new Date(today);
      currentDate.setDate(today.getDate() + i);

      if (isWeekend(currentDate)) continue;

      const dayString = Utilities.formatDate(currentDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      log('\n--- Processing Date: ' + dayString + ' ---', 'NORMAL');

      // --- v10.6: Build the daily cache for ALL unique stages ---
      const dailySlotCache = new Map();
      log('Building daily slot cache for ' + uniqueStageIds.length + ' stage(s)...', 'DEBUG');
      uniqueStageIds.forEach(function(stageId) {
        const slotsForStage = getSlotsForSingleStageDay(config.FOUNTAIN_API_KEY, stageId, currentDate);
        slotsForStage.forEach(function(slot) {
          dailySlotCache.set(slot.id, slot);
        });
      });
      const allSlotsForDay = Array.from(dailySlotCache.values());
      log('Cache built: Found ' + allSlotsForDay.length + ' unique slots for ' + dayString, 'NORMAL');

      // --- v10.6: Now loop through RECRUITERS and use the cache ---
      for (const email in groupedConfigs) {
        const stageConfigs = groupedConfigs[email];
        log('--- Processing Recruiter: ' + email + ' for ' + dayString + ' ---', 'DEBUG');

        const primaryConfig = stageConfigs[0];
        const allStageIds = stageConfigs.map(function(c) { return c.stageId; });
        const allSlotTitles = stageConfigs.map(function(c) { return c.slotTitle.toLowerCase(); });

        // --- v10.6: Filter the cache for this recruiter's slots ---
        const allExistingFountainSlotsToday = allSlotsForDay.filter(function(slot) {
          return slot.user_id && slot.user_id === primaryConfig.fountainId;
        });

        // --- v10.6: Get today's events from the pre-fetched list ---
        const { busyCalendarEventsToday } = getTodaysEvents(currentDate, allRecruiterEvents[email] || []);

        // --- v11.4: "Busy is Busy" logic is now inside this function ---
        const { slotsToDelete, safeSlots } = findConflictingSlots(
          config.FOUNTAIN_ORGANIZER_EMAIL,
          primaryConfig,
          allSlotTitles,
          allExistingFountainSlotsToday, // <-- Pass the filtered list
          busyCalendarEventsToday
        );

        if (slotsToDelete.length > 0) {
          log(' 	 -> Deleting ' + slotsToDelete.length + ' conflicting Fountain slots for ' + email, 'NORMAL');
          slotsToDelete.forEach(function(slot) {
            deleteFountainSlot(config.FOUNTAIN_API_KEY, slot.id);
          });
        }

        log('Found ' + safeSlots.length + ' valid Fountain slots and ' + busyCalendarEventsToday.length + ' busy Google Calendar events for ' + email, 'NORMAL');

        const allBusyTimesToday = safeSlots.concat(busyCalendarEventsToday);

        const netFreeTimeBlocks = calculateNetFreeTime(currentDate, primaryConfig, allBusyTimesToday);
        log('-> Calculated ' + netFreeTimeBlocks.length + ' net free time block(s) for ' + email, 'NORMAL');

        netFreeTimeBlocks.forEach(function(block) {
          createFountainSlots(config.FOUNTAIN_API_KEY, primaryConfig, allStageIds, block);
        });
      } // --- End Recruiter Loop ---
    } // --- End Day Loop ---

  } catch (e) {
    log('❌ An unexpected error occurred. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG'); // Log stack trace in debug mode
  }

  // --- v12.0: MODIFIED CACHE PRIMING STEP ---
  log('\n--- Priming GCal Cache for Delta Sync (Batch ' + currentBatch + '/' + totalBatches + ') ---', 'NORMAL');
  try {
    const scriptCache = CacheService.getScriptCache();
    for (const email in allRecruiterEvents) {
      // Only prime the cache for recruiters in the current batch
      if (recruiterEmailsForBatch.includes(email)) {
        const cacheKey = 'gcal_' + email;
        const eventsToCache = allRecruiterEvents[email];
        
        // Store for 23 hours (82800 seconds). Next full sync will refresh it.
        scriptCache.put(cacheKey, JSON.stringify(eventsToCache), 82800);
        log('✅ Successfully primed cache for ' + email + ' with ' + eventsToCache.length + ' events.', 'NORMAL');
      }
    }
  } catch (e) {
    log('❌ CRITICAL ERROR: Failed to prime GCal cache. Error: ' + e.toString(), 'NORMAL');
  }
  // --- End Cache Priming Step ---
 
  // --- v12.0: Advance the batch counter only on successful completion ---
  advanceBatchCounter();

  log('\n✅ NIGHTLY FULL SYNC (Batch ' + currentBatch + '/' + totalBatches + ') completed. Total UrlFetch calls made: ' + urlFetchCounter, 'NORMAL');
  } finally {
    // --- v12.2: Release the lock ---
    lock.releaseLock();
    log('Lock released.', 'DEBUG');
    // --- End Release Lock ---
  }
}

/**
 * [NEW HELPER v12.0]
 * Advances the batch counter in the script properties after a successful run.
 */
function advanceBatchCounter() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const propertyKey = 'fullSync_currentBatch';
  try {
    let currentBatch = parseInt(scriptProperties.getProperty(propertyKey), 10);
    if (isNaN(currentBatch) || currentBatch <= 0) {
      currentBatch = 1;
    }
    const nextBatch = currentBatch + 1;
    scriptProperties.setProperty(propertyKey, nextBatch.toString());
  } catch (e) {
    log('❌ CRITICAL ERROR: Could not advance the batch counter in Script Properties. Error: ' + e.toString(), 'NORMAL');
  }
}


/**
 * [NEW FUNCTION v11.0]
 * This is the FREQUENT DELTA SYNC. It runs every ~15 mins.
 */
function syncCalendars_Delta() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();
  const scriptCache = CacheService.getScriptCache();

  SCRIPT_LOG_LEVEL = config.LOGGING_LEVEL || 'NORMAL';
  urlFetchCounter = 0; // Reset API call counter

  // --- v11.0: Quiet Hours Check (Delta Version) ---
  const quietStart = parseInt(config.QUIET_HOURS_START || '22', 10);
  const quietEnd = parseInt(config.QUIET_HOURS_END || '6', 10);
  const currentHour = parseInt(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H'), 10);

  let isQuietTime = false;
  if (quietStart < quietEnd) { // Normal same-day range (e.g., 9 to 17)
    isQuietTime = currentHour >= quietStart && currentHour < quietEnd;
  } else { // Overnight range (e.g., 22 to 6)
    isQuietTime = currentHour >= quietStart || currentHour < quietEnd;
  }

  if (isQuietTime) {
    log('Current hour (' + currentHour + ') is within Quiet Hours (' + quietStart + '-' + quietEnd + '). Skipping DELTA sync.', 'NORMAL');
    return; // Exit script early
  }
  // --- End Quiet Hours Check ---

  log('🚀 Starting DELTA Sync (v11.4)...', 'NORMAL');

  if (!config.GOOGLE_SHEET_ID || config.GOOGLE_SHEET_ID.includes('YOUR_')) {
    log('🛑 ERROR: GOOGLE_SHEET_ID is not configured.', 'NORMAL');
    return;
  }
  if (typeof Calendar === 'undefined') {
    log('🛑 ERROR: Advanced Google Calendar API service is not enabled.', 'NORMAL');
    return;
  }

  const flatRecruiterConfigs = loadRecruiterConfig(config.GOOGLE_SHEET_ID);
  if (!flatRecruiterConfigs || flatRecruiterConfigs.length === 0) {
    log('🛑 Halting execution: No valid recruiter configurations found.', 'NORMAL');
    return;
  }

  const groupedConfigs = groupConfigsByRecruiter(flatRecruiterConfigs);
  const daysToSync = parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const syncStartDate = new Date(today);
  const syncEndDate = new Date(today);
  syncEndDate.setDate(today.getDate() + daysToSync);
  syncEndDate.setHours(23, 59, 59, 999);

  try {
    // --- v11.0: Loop by RECRUITER first ---
    for (const email in groupedConfigs) {
      log('\n--- Processing DELTA for: ' + email + ' ---', 'NORMAL');
      const stageConfigs = groupedConfigs[email];
      const primaryConfig = stageConfigs[0];
      const allStageIds = stageConfigs.map(function(c) { return c.stageId; });
      const cacheKey = 'gcal_' + email;

      // 1. Fetch Current GCal State
      const currentGCalEvents = getBusyCalendarEvents(email, syncStartDate, syncEndDate);
      log(' 	-> Found ' + currentGCalEvents.length + ' current GCal events.', 'DEBUG');

      // 2. Fetch Cached GCal State
      const cachedGCalData = scriptCache.get(cacheKey);
      if (!cachedGCalData) {
        log('⚠️ No cache found for ' + email + '. Skipping. (Will be synced by nightly full sync)', 'NORMAL');
        continue; // Skip this recruiter
      }
      const cachedGCalEvents = JSON.parse(cachedGCalData);
      log(' 	-> Found ' + cachedGCalEvents.length + ' cached GCal events.', 'DEBUG');
      
      // 3. Compare (Find Deltas)
      const deltas = findGCalDeltas(cachedGCalEvents, currentGCalEvents);
      log(' 	-> Found ' + deltas.newOrUpdated.length + ' new/updated and ' + deltas.deleted.length + ' deleted GCal events.', 'NORMAL');

      // 4. Action Deltas: New/Updated (Delete Fountain Slots)
      if (deltas.newOrUpdated.length > 0) {
        log(' 	-> Processing ' + deltas.newOrUpdated.length + ' new/updated GCal events (deleting slots)...', 'NORMAL');
        
        const daysToFetch = new Set();
        deltas.newOrUpdated.forEach(function(event) {
          let d = new Date(event.start);
          while (d <= event.end) {
              daysToFetch.add(Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'));
              d.setDate(d.getDate() + 1);
          }
        });

        let slotsToDelete = [];

        // For each day that has a new/updated event...
        daysToFetch.forEach(function(dayString) {
          const forDate = new Date(dayString + 'T12:00:00Z'); // Use noon to avoid timezone issues
          log(' 	 	-> Checking for slots to delete on: ' + dayString, 'DEBUG');
          let fountainSlotsForDay = new Map();

          // Get all Fountain slots for this recruiter on this day
          allStageIds.forEach(function(stageId) {
            const slots = getSlotsForSingleStageDay(config.FOUNTAIN_API_KEY, stageId, forDate);
            slots.forEach(function(slot) { fountainSlotsForDay.set(slot.id, slot); });
          });

          // Filter for *this* recruiter's unbooked slots
          const recruiterSlots = Array.from(fountainSlotsForDay.values()).filter(function(slot) {
            return slot.user_id === primaryConfig.fountainId && slot.booked_slots_count === 0;
          });

          if (recruiterSlots.length === 0) return; // No slots to check on this day

          // Find the new/updated events that apply to *this* day
          const newEventsForDay = deltas.newOrUpdated.filter(function(event) {
              return event.start <= new Date(dayString + 'T23:59:59Z') && event.end >= new Date(dayString + 'T00:00:00Z');
          });

          // Now, find conflicts between this day's slots and this day's new events
          recruiterSlots.forEach(function(slot) {
            newEventsForDay.forEach(function(event) {
              // Check for overlap: (SlotStart < EventEnd) and (SlotEnd > EventStart)
              if (slot.start < event.end && slot.end > event.start) {
                log(' 	 	-> CONFLICT (New Event): Slot ' + slot.id + ' (' + slot.start.toLocaleTimeString() + ') conflicts with new GCal event "' + event.title + '". Flagging for deletion.', 'NORMAL');
                slotsToDelete.push(slot);
              }
            });
          });
        });

        // Delete all conflicting slots (de-duplicated)
        [...new Set(slotsToDelete.map(s => s.id))].forEach(function(slotId) {
          deleteFountainSlot(config.FOUNTAIN_API_KEY, slotId);
        });
      } // End processing new/updated deltas

      // 5. Action Deltas: Deleted (Create Fountain Slots)
      if (deltas.deleted.length > 0) {
        log(' 	-> Processing ' + deltas.deleted.length + ' deleted GCal events (creating slots)...', 'NORMAL');

        deltas.deleted.forEach(function(event) {
          // 'event' is the block of newly free time
          log(' 	 	-> New opening found: "' + event.title + '" from ' + event.start.toLocaleString() + ' to ' + event.end.toLocaleString(), 'NORMAL');

          const forDate = new Date(event.start);
          const workStart = new Date(forDate);
          const [startHour, startMinute] = primaryConfig.startTime.split(':');
          workStart.setHours(parseInt(startHour, 10), parseInt(startMinute, 10), 0, 0);

          const workEnd = new Date(forDate);
          const [endHour, endMinute] = primaryConfig.endTime.split(':');
          workEnd.setHours(parseInt(endHour, 10), parseInt(endMinute, 10), 0, 0);

          // Find the actual free block within work hours
          const blockStart = new Date(Math.max(workStart.getTime(), event.start.getTime()));
          const blockEnd = new Date(Math.min(workEnd.getTime(), event.end.getTime()));
          
          const freeBlock = { start: blockStart, end: blockEnd };
          const durationMinutes = (freeBlock.end.getTime() - freeBlock.start.getTime()) / 60000;

          if (freeBlock.end > freeBlock.start && durationMinutes >= primaryConfig.slotLength) {
              log(' 	 	-> Creating slots in new free block: ' + freeBlock.start.toLocaleTimeString() + ' - ' + freeBlock.end.toLocaleTimeString(), 'NORMAL');
              createFountainSlots(config.FOUNTAIN_API_KEY, primaryConfig, allStageIds, freeBlock);
          } else {
              log(' 	 	-> Skipping new free block (outside work hours or too short).', 'DEBUG');
          }
        });
      } // End processing deleted deltas

      // 6. Update Cache for this recruiter
      const newCacheValue = JSON.stringify(currentGCalEvents);
      scriptCache.put(cacheKey, newCacheValue, 82800); // 23-hour expiry
      log(' 	-> Successfully updated cache for ' + email, 'DEBUG');

    } // --- End Recruiter Loop ---
  } catch (e) {
    log('❌ An unexpected error occurred during DELTA sync. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG'); // Log stack trace in debug mode
  }

  log('\n✅ DELTA Sync process completed. Total UrlFetch calls made: ' + urlFetchCounter, 'NORMAL');
}


// --- HELPER FUNCTIONS ---

/**
 * [NEW HELPER v11.0]
 * Compares two GCal event lists (cached vs. current) and finds the differences.
 */
function findGCalDeltas(cachedEvents, currentEvents) {
  const cachedMap = new Map();
  // Dates from JSON are strings, must be parsed
  cachedEvents.forEach(function(event) {
    cachedMap.set(event.id, {
      title: event.title,
      start: new Date(event.start).getTime(),
      end: new Date(event.end).getTime()
    });
  });

  const currentMap = new Map();
  // Dates from GCal API are Date objects
  currentEvents.forEach(function(event) {
    currentMap.set(event.id, {
      title: event.title,
      start: event.start.getTime(),
      end: event.end.getTime()
    });
  });

  const newOrUpdated = [];
  const deleted = [];

  // 1. Find New or Updated Events
  currentEvents.forEach(function(currentEvent) {
    const cachedEvent = cachedMap.get(currentEvent.id);
    const currentEventTime = { start: currentEvent.start.getTime(), end: currentEvent.end.getTime() };

    if (!cachedEvent) {
      newOrUpdated.push(currentEvent); // Push the full event object
    } else if (cachedEvent.start !== currentEventTime.start || cachedEvent.end !== currentEventTime.end) {
      newOrUpdated.push(currentEvent); // Push the full event object
    }
  });

  // 2. Find Deleted Events
  cachedEvents.forEach(function(cachedEvent) {
    if (!currentMap.has(cachedEvent.id)) {
      // Re-hydrate the Date objects for the deleted event
      deleted.push({
        id: cachedEvent.id,
        title: cachedEvent.title,
        start: new Date(cachedEvent.start),
        end: new Date(cachedEvent.end)
      });
    }
  });

  return { newOrUpdated: newOrUpdated, deleted: deleted };
}

/**
 * [NEW HELPER v12.0]
 * Manages batching of recruiters for the full sync.
 * Uses PropertiesService to track the current batch number.
 */
function getNextRecruiterBatch(config, allRecruiterConfigs) {
  const scriptProperties = PropertiesService.getScriptProperties();
  const propertyKey = 'fullSync_currentBatch';
  const batchSize = parseInt(config.RECRUITER_BATCH_SIZE, 10) || 10;

  const allRecruiterEmails = [...new Set(allRecruiterConfigs.map(c => c.email))];
  const totalBatches = Math.ceil(allRecruiterEmails.length / batchSize);

  // Get current batch number from properties, or start at 1
  const propertyValue = scriptProperties.getProperty(propertyKey);
  let currentBatch = parseInt(propertyValue, 10);
  if (isNaN(currentBatch) || currentBatch <= 0) {
    currentBatch = 1;
  }

  // If the current batch number is greater than the total, we're done.
  if (currentBatch > totalBatches) {
    return { currentBatch: currentBatch, totalBatches: totalBatches, recruiterEmailsForBatch: [] };
  }

  // Calculate the slice of recruiters for the current batch
  const startIndex = (currentBatch - 1) * batchSize;
  const endIndex = startIndex + batchSize;
  const recruiterEmailsForBatch = allRecruiterEmails.slice(startIndex, endIndex);

  // BATCH COUNTER IS NOW ADVANCED SEPARATELY AFTER SUCCESSFUL EXECUTION

  return {
    currentBatch: currentBatch,
    totalBatches: totalBatches,
    recruiterEmailsForBatch: recruiterEmailsForBatch
  };
}


function groupConfigsByRecruiter(configs) {
  const grouped = {};
  configs.forEach(function(config) {
    if (!grouped[config.email]) {
      grouped[config.email] = [];
    }
    grouped[config.email].push(config);
  });
  return grouped;
}

function isWeekend(date) {
  const dayOfWeek = date.getDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    const dayString = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    log('--- Skipping ' + dayString + ' (Weekend) ---', 'NORMAL');
    return true;
  }
  return false;
}

function getTodaysEvents(currentDate, allEvents) {
  const dayStart = new Date(currentDate);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(currentDate);
  dayEnd.setHours(23, 59, 59, 999);

  const todaysEvents = allEvents.filter(function(event) {
    if (!event || !event.start || !event.end) return false;
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    return eventStart < dayEnd && eventEnd > dayStart;
  });

  return { busyCalendarEventsToday: todaysEvents, dayStart: dayStart, dayEnd: dayEnd };
}


/**
 * [MODIFIED FUNCTION v10]
 * Loads recruiter configurations from the sheet.
 */
function loadRecruiterConfig(sheetId) {
  try {
    const sheet = SpreadsheetApp.openById(sheetId).getSheets()[0];
    const data = sheet.getDataRange().getDisplayValues();

    if (data.length < 2) {
      log('⚠️ Warning: Config sheet is empty or has only a header row.', 'NORMAL');
      return [];
    }

    const header = data.shift(); // Remove header row
    const requiredHeaders = [
      'Google_Calendar_Email', 'Fountain_User_ID', 'Work_Start_Time',
      'Work_End_Time', 'Slot_Length_Minutes', 'Stage_IDs', 'Slot_Title'
    ];
    const headerIndices = {};

    requiredHeaders.forEach(function(h) {
      const index = header.indexOf(h);
      if (index === -1) {
        throw new Error('Missing required header column in Google Sheet: ' + h);
      }
      headerIndices[h] = index;
    });

    const configs = []; // FLAT list of config objects
    data.forEach(function(row, i) {
      if (row.length < requiredHeaders.length || !row[headerIndices.Google_Calendar_Email] || !row[headerIndices.Fountain_User_ID]) {
          log('⚠️ Skipping row ' + (i + 2) + ': Missing Google_Calendar_Email or Fountain_User_ID.', 'NORMAL');
          return; // Skip this row
      }

      const email = row[headerIndices.Google_Calendar_Email];
      const fountainId = row[headerIndices.Fountain_User_ID];

      const commonProps = {
        email: email.trim(),
        fountainId: fountainId.trim(),
        startTime: row[headerIndices.Work_Start_Time],
        endTime: row[headerIndices.Work_End_Time],
        slotLength: parseInt(row[headerIndices.Slot_Length_Minutes], 10)
      };

      const timeRegex = /^\d{1,2}:\d{2}$/;
      if (!timeRegex.test(commonProps.startTime) || !timeRegex.test(commonProps.endTime)) {
          log('⚠️ Skipping recruiter ' + email + ': Invalid Work_Start_Time or Work_End_Time format. Use HH:MM.', 'NORMAL');
          return;
      }
      if (isNaN(commonProps.slotLength) || commonProps.slotLength <= 0) {
          log('⚠️ Skipping recruiter ' + email + ': Invalid Slot_Length_Minutes. Must be a positive number.', 'NORMAL');
          return;
      }

      const stageIdsStr = row[headerIndices.Stage_IDs];
      const singleSlotTitle = row[headerIndices.Slot_Title];

      if (!stageIdsStr || !singleSlotTitle) {
        log('⚠️ Skipping recruiter ' + email + ': Missing Stage_IDs or Slot_Title.', 'NORMAL');
        return;
      }

      const trimmedTitle = singleSlotTitle.trim();
      const stageIds = stageIdsStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

      if (stageIds.length === 0) {
          log('⚠️ Skipping recruiter ' + email + ': No valid Stage_IDs found after splitting.', 'NORMAL');
          return;
      }

      // Create a config object for EACH stage
      stageIds.forEach(function(stageId) {
        configs.push({
          email: commonProps.email,
          fountainId: commonProps.fountainId,
          startTime: commonProps.startTime,
          endTime: commonProps.endTime,
          slotLength: commonProps.slotLength,
          stageId: stageId,
          slotTitle: trimmedTitle
        });
      });
    }); // end of data.forEach (row loop)

    log('✅ Successfully loaded ' + configs.length + ' total stage configurations from ' + data.length + ' recruiter row(s).', 'NORMAL');
    return configs;

  } catch (e) {
    log('❌ CRITICAL ERROR: Could not read or parse the Google Sheet. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
    return null; // Return null on critical error
  }
}


/**
 * [HELPER FUNCTION v10.6]
 * Fetches existing Fountain slots for a *single stage* on a *single day*.
 */
function getSlotsForSingleStageDay(apiKey, stageId, forDate) {
  const slots = [];
  const dateString = Utilities.formatDate(forDate, Session.getScriptTimeZone(), 'MM-dd-yyyy');

  const baseUrl = 'https://ceracare.fountain.com/api/v2/sessions?with_unbooked=true' +
                  '&stage_id=' + stageId +
                  '&time=range=' + dateString + '*' + dateString;
  let page = 1;

  while (true) {
    const url = baseUrl + '&page=' + page;
    const options = {
      'method': 'get',
      'headers': { 'X-ACCESS-TOKEN': apiKey },
      'muteHttpExceptions': true
    };

    const response = fetchWithCounting(url, options);

    if (response.getResponseCode() !== 200) {
      log(' -> API call failed for stage ' + stageId + ' on ' + dateString + '. Status: ' + response.getResponseCode(), 'NORMAL');
      break;
    }

    let data;
    try {
      data = JSON.parse(response.getContentText());
    } catch (e) {
        log(' -> Failed to parse JSON response for stage ' + stageId + ' on ' + dateString + '. Error: ' + e, 'NORMAL');
        break;
    }

    const sessions = data.sessions;
    if (!sessions || sessions.length === 0) break;

    sessions.forEach(function(session) {
      slots.push({
        id: session.id,
        start: new Date(session.start_time),
        end: new Date(session.end_time),
        booked_slots_count: session.booked_slots_count || 0,
        user_id: session.user_id // <-- CRITICAL
      });
    });

    if (!data.pagination || !data.pagination.next) break;
    page++;
  }
  log('Fetched ' + slots.length + ' total slots for stage ' + stageId + ' on ' + dateString, 'DEBUG');
  return slots;
}


/**
 * Fetches and filters Google Calendar events to identify busy times.
 * [MODIFIED v11.0] Now returns the GCal Event ID.
 */
function getBusyCalendarEvents(calendarId, startDate, endDate) {
  try {
    const HOLIDAY_KEYWORDS = ['holiday', 'annual leave', 'out of office', 'ooo', 'leave', 'pto'];

    const eventsResponse = Calendar.Events.list(calendarId, {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime'
    });

    const events = eventsResponse.items;
    if (!events) return [];

    log('--- Analyzing ' + events.length + ' Google Calendar events for ' + calendarId + '... ---', 'DEBUG');

    const busyEvents = events.filter(function(event) {
      const title = event.summary || '';
      const lowerCaseTitle = title.toLowerCase();

      const self = (event.attendees || []).find(function(attendee) { return attendee.self; });
      const status = self ? self.responseStatus : 'needsAction';
      const isOwner = (event.organizer && event.organizer.self);
      const isAllDay = !!event.start.date;

      log(' 	 	-> Found Event: "' + title + '", All-Day: ' + isAllDay + ', Status: ' + status, 'DEBUG');

      // --- Filtering Logic ---
      if (lowerCaseTitle.includes('out of office')) {
        log(' 	 	 	 - Decision: KEEP (High-priority "Out of office" event)', 'DEBUG');
          return true;
      }
      if (title.includes('Working location:')) {
        log(' 	 	 	 - Decision: IGNORE (Working Location)', 'DEBUG');
        return false;
      }
      if (isAllDay) {
        const isHoliday = HOLIDAY_KEYWORDS.some(function(keyword) { return lowerCaseTitle.includes(keyword); });
        if (isHoliday) {
          log(' 	 	 	 - Decision: KEEP (Holiday/OOO All-day event)', 'DEBUG');
          return true;
        } else {
          log(' 	 	 	 - Decision: IGNORE (Non-holiday All-day event)', 'DEBUG');
          return false;
        }
      }

      const isBusy = status === 'accepted' || isOwner;
      if (isBusy) {
          log(' 	 	 	 - Decision: KEEP (Accepted/Owned regular event)', 'DEBUG');
      } else {
          log(' 	 	 	 - Decision: IGNORE (Unaccepted/Tentative regular event)', 'DEBUG');
      }
      return isBusy;
    });

    log('--- Kept ' + busyEvents.length + ' busy events for final calculation. ---', 'DEBUG');

    return busyEvents.map(function(event) {
        return {
          id: event.id, // <-- v11.0: CRITICAL for delta comparison
          title: event.summary || '',
          start: new Date((event.start.dateTime || event.start.date)),
          end: new Date((event.end.dateTime || event.end.date)),
          organizer: event.organizer
        };
      });
  } catch (e) {
    log('❌ Error fetching calendar events for ' + calendarId + ': ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
    return [];
  }
}

/**
 * [MODIFIED FUNCTION v11.4 - "Busy is Busy" Logic]
 * Identifies Fountain slots that conflict with busy calendar events.
 * This version removes the "legitimate booking" check. If an UNBOOKED slot
 * overlaps with ANY busy GCal event, it is flagged for deletion.
 */
function findConflictingSlots(fountainOrganizerEmail, primaryConfig, allSlotTitles, existingSlots, busyEvents) {
  const slotsToDelete = [];
  const safeSlots = [];

  existingSlots.forEach(function(slot) {
    // --- 1. Protect all BOOKED slots ---
    // This logic is unchanged and correct.
    if (slot.booked_slots_count > 0) {
      log(' 	 -> Protecting slot ' + slot.id + ' (' + slot.start.toLocaleTimeString() + ') because it is already booked.', 'NORMAL');
      safeSlots.push(slot);
      return;
    }

    // --- 2. Check UNBOOKED slots against all busy GCal events ---
    let isConflicting = false;
    for (const event of busyEvents) {
      const eventStart = new Date(event.start);
      const eventEnd = new Date(event.end);

      // "Busy is Busy" check: (SlotStart < EventEnd) and (SlotEnd > EventStart)
      if (slot.start < eventEnd && slot.end > eventStart) {
        log(' 	 -> Found overlap: UNBOOKED slot ' + slot.id + ' conflicts with GCal event "' + event.title + '". Flagging for deletion.', 'NORMAL');
        isConflicting = true;
        slotsToDelete.push(slot);
        
        // We found a conflict, no need to check this slot against other events.
        break; 
      }
    } // End loop through busyEvents

    // --- 3. If no conflicts were found, keep the unbooked slot ---
    if (!isConflicting) {
      safeSlots.push(slot);
    }
  }); // End loop through existingSlots

  // Return the de-duplicated list of slots to delete
  return { slotsToDelete: [...new Set(slotsToDelete)], safeSlots: safeSlots };
}


function deleteFountainSlot(apiKey, slotId) {
  const url = 'https://ceracare.fountain.com/api/v2/available_slots/' + slotId;
  const options = {
    'method': 'delete',
    'headers': { 'X-ACCESS-TOKEN': apiKey },
    'muteHttpExceptions': true
  };

  try {
    log(' 	 	 Deleting slot ID: ' + slotId, 'DEBUG');
    const response = fetchWithCounting(url, options);
    if (response.getResponseCode() === 200) {
      log(' 	 	 ✅ Successfully deleted slot ' + slotId, 'NORMAL');
    } else {
      log(' 	 	 ❌ Failed to delete slot ' + slotId + '. Status: ' + response.getResponseCode() + ', Response: ' + response.getContentText(), 'NORMAL');
    }
  } catch (e) {
    log(' 	 	 ❌ Exception while deleting slot ' + slotId + '. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
  }
}

/**
 * [NEW UTILITY v12.1]
 * Programmatically creates a specific, limited set of triggers for the nightly sync.
 */
function setupNightlyTriggers() {
  const targetFunctionName = 'syncCalendars_Full';
  const triggers = ScriptApp.getProjectTriggers();

  // 1. Delete all existing triggers for the target function to avoid duplicates.
  log('Deleting existing triggers for ' + targetFunctionName + '...', 'NORMAL');
  let deletedCount = 0;
  triggers.forEach(function(trigger) {
    if (trigger.getHandlerFunction() === targetFunctionName) {
      ScriptApp.deleteTrigger(trigger);
      deletedCount++;
    }
  });
  log('✅ Deleted ' + deletedCount + ' existing trigger(s).', 'NORMAL');

  // 2. Reset the batch counter to 1 for a clean start.
  const scriptProperties = PropertiesService.getScriptProperties();
  scriptProperties.setProperty('fullSync_currentBatch', '1');
  log('✅ Batch counter has been reset to 1 for the new nightly cycle.', 'NORMAL');

  // 3. Read the trigger configuration from Script Properties.
  const config = scriptProperties.getProperties();

  const numberOfTriggers = parseInt(config.TRIGGER_COUNT, 10) || 10;
  const intervalMinutes = parseInt(config.TRIGGER_INTERVAL_MINUTES, 10) || 15;
  const startHour = parseInt(config.TRIGGER_START_HOUR, 10) || 1;

  log('Trigger Configuration -> Count: ' + numberOfTriggers + ', Interval: ' + intervalMinutes + ' mins, Start Hour: ' + startHour + ':00', 'NORMAL');

  const startTime = new Date();
  startTime.setHours(startHour, 0, 0, 0); // Set to 1:00:00 AM today

  // If 1 AM has already passed today, schedule it for tomorrow.
  if (new Date() > startTime) {
    startTime.setDate(startTime.getDate() + 1);
    log('1 AM has already passed today. Scheduling triggers for tomorrow.', 'NORMAL');
  } else {
    log('Scheduling triggers for today, starting at 1 AM.', 'NORMAL');
  }


  // 3. Create the new triggers.
  log('Creating ' + numberOfTriggers + ' new triggers...', 'NORMAL');
  for (let i = 0; i < numberOfTriggers; i++) {
    const triggerTime = new Date(startTime.getTime() + i * intervalMinutes * 60 * 1000);
    try {
      ScriptApp.newTrigger(targetFunctionName)
        .timeBased()
        .at(triggerTime)
        .create();
      log(' 	-> ✅ Created trigger #' + (i + 1) + ' to run at: ' + triggerTime.toLocaleString(), 'NORMAL');
    } catch (e) {
      log(' 	-> ❌ Failed to create trigger #' + (i + 1) + '. Error: ' + e.toString(), 'NORMAL');
    }
  }
  log('✅ Trigger setup complete.', 'NORMAL');
}


/**
 * Calculates blocks of free time within working hours.
 */
function calculateNetFreeTime(forDate, recruiter, allBusyTimes) {
  const workStart = new Date(forDate);
  const [startHour, startMinute] = recruiter.startTime.split(':');
  workStart.setHours(parseInt(startHour, 10), parseInt(startMinute, 10), 0, 0);

  const workEnd = new Date(forDate);
  const [endHour, endMinute] = recruiter.endTime.split(':');
  workEnd.setHours(parseInt(endHour, 10), parseInt(endMinute, 10), 0, 0);

  if (workStart >= workEnd) {
      log(' -> Invalid work hours (' + recruiter.startTime + '-' + recruiter.endTime + ').', 'NORMAL');
      return [];
  }

  let freeBlocks = [{ start: workStart, end: workEnd }];

  const busyTimesToday = allBusyTimes.sort(function(a, b) { 
    return new Date(a.start) - new Date(b.start); 
  });

  log(' -> Calculating free time between ' + workStart.toLocaleTimeString() + ' and ' + workEnd.toLocaleTimeString() +
      ' considering ' + busyTimesToday.length + ' busy blocks.', 'DEBUG');

  busyTimesToday.forEach(function(busy) {
    const busyStart = new Date(busy.start);
    const busyEnd = new Date(busy.end);
    if (isNaN(busyStart) || isNaN(busyEnd)) return;

    const nextFreeBlocks = [];
    freeBlocks.forEach(function(free) {
      if (free.end <= busyStart || free.start >= busyEnd) {
        nextFreeBlocks.push(free);
        return;
      }
      if (free.start < busyStart) {
        nextFreeBlocks.push({ start: free.start, end: busyStart });
      }
      if (free.end > busyEnd) {
        nextFreeBlocks.push({ start: busyEnd, end: free.end });
      }
    });
    freeBlocks = nextFreeBlocks;
  });

  if (recruiter.slotLength === 30) {
    log(' 	 -> Applying 30-minute quantization rules...', 'DEBUG');
    const thirtyMinInMillis = 30 * 60 * 1000;
    const quantizedBlocks = freeBlocks.map(function(block) {
      const roundedStartMillis = Math.ceil(block.start.getTime() / thirtyMinInMillis) * thirtyMinInMillis;
      const newStart = new Date(roundedStartMillis);
      const roundedEndMillis = Math.floor(block.end.getTime() / thirtyMinInMillis) * thirtyMinInMillis;
      const newEnd = new Date(roundedEndMillis);
      return { start: newStart, end: newEnd };
    });
    freeBlocks = quantizedBlocks;
  }

  return freeBlocks.filter(function(block) {
    if (!(block.start instanceof Date) || !(block.end instanceof Date) || isNaN(block.start) || isNaN(block.end)) return false;
    const durationMillis = block.end.getTime() - block.start.getTime();
    const durationMinutes = durationMillis / 60000;
    const isValid = block.end > block.start && durationMinutes >= recruiter.slotLength;
    if (isValid) {
      log(' --> Keeping free block: ' + block.start.toLocaleTimeString() + ' - ' + block.end.toLocaleTimeString(), 'DEBUG');
    } else {
      log(' --> Discarding small/invalid free block: ' + block.start.toLocaleTimeString() + ' - ' + block.end.toLocaleTimeString(), 'DEBUG');
    }
    return isValid;
  });
}


/**
 * [REVERTED FUNCTION]
 * Creates Fountain slots using the recruiter's email.
 */
function createFountainSlots(apiKey, primaryConfig, allStageIds, block) {
  // --- REVERTED PAYLOAD: Uses recruiter_email instead of user_id ---
  const payload = {
    recruiter_email: primaryConfig.email, // <-- REVERTED: Using email now
    start_time: block.start.toISOString(),
    end_time: block.end.toISOString(),
    max_attendees: 1,
    split: primaryConfig.slotLength,
    stage_ids: allStageIds,
    title: primaryConfig.slotTitle
  };

  const options = {
    'method': 'post',
    'contentType': 'application/json',
    'headers': { 'X-ACCESS-TOKEN': apiKey },
    'payload': JSON.stringify(payload),
    'muteHttpExceptions': true
  };

  try {
    log(' 	 -> Creating slots for block ' + block.start.toLocaleTimeString() + ' - ' + block.end.toLocaleTimeString() + ' (Email: ' + primaryConfig.email + ')', 'NORMAL');
    
    const response = fetchWithCounting('https://ceracare.fountain.com/api/v2/available_slots', options);

    if (response.getResponseCode() === 201) {
      log(' 	 ✅ Successfully created slots.', 'NORMAL');
    // --- REVERTED: Removed v11.3 404 diagnostic logic ---
    } else {
      log(' 	 ❌ Failed to create slots. Status: ' + response.getResponseCode() + ', Response: ' + response.getContentText(), 'NORMAL');
    }
  } catch (e) {
    log(' 	 ❌ Exception creating slots: ' + e.toString(), 'NORMAL');
  }
}


// =====================================================================================
// ==================== MANUAL ADMIN UTILITY FUNCTIONS =================================
// =====================================================================================

/**
 * [MANUAL FUNCTION]
 * Reads tasks from the "Delete Tasks" sheet and deletes UNBOOKED Fountain slots
 * matching the specified User ID and Stage ID.
 */
function bulkDeleteSlots() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();

  SCRIPT_LOG_LEVEL = 'NORMAL';
  urlFetchCounter = 0;

  log('🚀 Starting Bulk Slot Deletion Utility...', 'NORMAL');

  const deleteTasks = loadDeleteTasks(config.GOOGLE_SHEET_ID);
  if (!deleteTasks || deleteTasks.length === 0) {
    log('🛑 Halting: No delete tasks found in the "Delete Tasks" sheet.', 'NORMAL');
    return;
  }

  log('Found ' + deleteTasks.length + ' task(s) to process.', 'NORMAL');

  deleteTasks.forEach(function(task) {
    log('\n================== Processing Task ==================', 'NORMAL');
    log('User ID: ' + task.userId, 'NORMAL');
    log('Stage ID: ' + task.stageId, 'NORMAL');
    try {
      const allSlotsForStage = getAllSlotsForTask(config.FOUNTAIN_API_KEY, task);
      log('Found ' + allSlotsForStage.length + ' total slots for the stage (all users).', 'NORMAL');

      const userSlots = allSlotsForStage.filter(slot => slot.user_id === task.userId);

      if (userSlots.length === 0) {
        log('✅ No slots found for this user/stage combination.', 'NORMAL');
        return;
      }
      log('Found ' + userSlots.length + ' slots associated with user ' + task.userId + '.', 'NORMAL');

      const slotsToDelete = userSlots.filter(slot => slot.booked_slots_count === 0);

      const bookedCount = userSlots.length - slotsToDelete.length;
      if (bookedCount > 0) {
        log(' 	 -> Skipping ' + bookedCount + ' slot(s) that are already booked.', 'NORMAL');
      }

      if (slotsToDelete.length === 0) {
        log('✅ No unbooked slots found for this user/stage to delete.', 'NORMAL');
        return;
      }

      log(' 	 -> Targeting ' + slotsToDelete.length + ' unbooked slots for deletion...', 'NORMAL');
      slotsToDelete.forEach(function(slot) {
        deleteFountainSlot(config.FOUNTAIN_API_KEY, slot.id);
      });

    } catch (e) {
      log('❌ An error occurred while processing task for user ' + task.userId + '. Error: ' + e.toString(), 'NORMAL');
      log(e.stack, 'DEBUG');
    }
  }); // End loop through deleteTasks

  log('\n✅ Bulk delete process completed. Total UrlFetch calls made: ' + urlFetchCounter, 'NORMAL');
}


/**
 * Loads deletion tasks from a specific sheet named "Delete Tasks".
 */
function loadDeleteTasks(sheetId) {
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const sheet = ss.getSheetByName('Delete Tasks');
    if (!sheet) {
      throw new Error('Sheet named "Delete Tasks" could not be found.');
    }
    const data = sheet.getDataRange().getDisplayValues();

    if (data.length < 2) {
      log('⚠️ "Delete Tasks" sheet is empty or has only a header row.', 'NORMAL');
      return [];
    }

    const header = data.shift();
    const userIdIndex = header.indexOf('Fountain_User_ID');
    const stageIdsIndex = header.indexOf('Stage_IDs'); // <-- Look for 'Stage_IDs'

    if (userIdIndex === -1 || stageIdsIndex === -1) {
      throw new Error('"Delete Tasks" sheet must have columns "Fountain_User_ID" and "Stage_IDs".');
    }

    const tasks = [];
    data.forEach(function(row) {
      if (row.length > Math.max(userIdIndex, stageIdsIndex) && row[userIdIndex] && row[stageIdsIndex]) {
        const userId = row[userIdIndex].trim();
        const stageIdsStr = row[stageIdsIndex];

        const stageIds = stageIdsStr.split(',').map(s => s.trim()).filter(Boolean);

        if (stageIds.length === 0) {
            log('⚠️ Skipping row for User ID ' + userId + ': No valid Stage_IDs found.', 'NORMAL');
            return;
        }

        // Create a task for EACH stage
        stageIds.forEach(function(stageId) {
          tasks.push({
            userId: userId,
            stageId: stageId
          });
        });
      }
    });
    return tasks;

  } catch (e) {
    log('❌ CRITICAL ERROR: Could not read "Delete Tasks" sheet. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
    return null;
  }
}

/**
 * Fetches ALL slots (past and future, up to 1 year) for a specific stage ID.
 */
function getAllSlotsForTask(apiKey, task) {
  const allSlots = [];
  const today = new Date();
  const futureDate = new Date();
  futureDate.setFullYear(today.getFullYear() + 1);

  const dateStringStart = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MM-dd-yyyy');
  const dateStringEnd = Utilities.formatDate(futureDate, Session.getScriptTimeZone(), 'MM-dd-yyyy');

  const baseUrl = 'https://ceracare.fountain.com/api/v2/sessions?with_unbooked=true' +
                  '&stage_id=' + task.stageId +
                  '&time=range=' + dateStringStart + '*' + dateStringEnd;
  let page = 1;

  while (true) {
    const url = baseUrl + '&page=' + page;
    const options = { 'method': 'get', 'headers': { 'X-ACCESS-TOKEN': apiKey }, 'muteHttpExceptions': true };
    const response = fetchWithCounting(url, options);

    if (response.getResponseCode() !== 200) {
      log(' 	 -> API call to fetch slots failed for task stage ' + task.stageId + '. Status: ' + response.getResponseCode(), 'NORMAL');
      break;
    }

    let data;
    try {
      data = JSON.parse(response.getContentText());
    } catch (e) {
      log(' -> Failed to parse JSON response for task stage ' + task.stageId + '. Error: ' + e, 'NORMAL');
      break;
    }

    const sessions = data.sessions;
    if (!sessions || sessions.length === 0) break;

    // Parse into the simplified format
    sessions.forEach(function(session) {
      allSlots.push({
        id: session.id,
        start: new Date(session.start_time),
        end: new Date(session.end_time),
        booked_slots_count: session.booked_slots_count || 0,
        user_id: session.user_id
      });
    });

    if (!data.pagination || !data.pagination.next) break;
    page++;
  }
  return allSlots;
}


/**
 * [MANUAL FUNCTION]
* Analyzes calendar events for "<>" identifier issues.
 */
function analyzeCalendarForFountainIdentifier() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();
  SCRIPT_LOG_LEVEL = 'NORMAL';
  log('🚀 Starting Calendar Analysis for "<>" Identifier...', 'NORMAL');

  const flatRecruiterConfigs = loadRecruiterConfig(config.GOOGLE_SHEET_ID);
  if (!flatRecruiterConfigs || flatRecruiterConfigs.length === 0) {
    log('🛑 Halting: No recruiter configurations found.', 'NORMAL');
    return;
  }

  const groupedConfigs = groupConfigsByRecruiter(flatRecruiterConfigs);
  const daysToSync = parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let potentialFalsePositives = 0;

  for (const email in groupedConfigs) {
    log('\n================== Analyzing Calendar for: ' + email + ' ==================', 'NORMAL');
    try {
      const syncStartDate = new Date(today);
      const syncEndDate = new Date(today);
      syncEndDate.setDate(today.getDate() + daysToSync);
      syncEndDate.setHours(23, 59, 59, 999);

      const calendar = CalendarApp.getCalendarById(email);
      if (!calendar) {
        log('⚠️ Could not access Google Calendar for ' + email + ' using CalendarApp. Skipping.', 'NORMAL');
        continue;
      }

      const events = calendar.getEvents(syncStartDate, syncEndDate);
      log('Found ' + events.length + ' total events via CalendarApp to analyze.', 'NORMAL');

      events.forEach(function(event) {
        const title = event.getTitle();
        const isLegitimateFountainEvent = title.includes(': ') && title.includes('<>');

        if (title.includes('<>') && !isLegitimateFountainEvent) {
            potentialFalsePositives++;
            log(' 	 -> ⚠️ POTENTIAL FALSE POSITIVE FOUND!', 'NORMAL');
            log(' 	 	- Title: "' + title + '"', 'NORMAL');
            log(' 	 	- Start Time: ' + event.getStartTime(), 'NORMAL');
        }
      });
    } catch (e) {
      log('❌ An error occurred while analyzing calendar for ' + email + '. Error: ' + e.toString(), 'NORMAL');
      log(e.stack, 'DEBUG');
    }
  } // End loop

  if (potentialFalsePositives === 0) {
    log('\n✅ Analysis complete. No potential false positives found for the "<>" identifier.', 'NORMAL');
  } else {
    log('\n✅ Analysis complete. Found ' + potentialFalsePositives + ' potential false positive(s).', 'NORMAL');
  }
}

/**
 * [MANUAL FUNCTION]
 * Runs a simulation of the `syncCalendars_Full` logic but ONLY logs potential deletions.
 */
function analyzePotentialDeletions() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();

  SCRIPT_LOG_LEVEL = 'NORMAL';
  urlFetchCounter = 0;

  log('🚀 Starting Potential Deletion Analysis (Simulation)...', 'NORMAL');

  const flatRecruiterConfigs = loadRecruiterConfig(config.GOOGLE_SHEET_ID);
  if (!flatRecruiterConfigs || flatRecruiterConfigs.length === 0) {
    log('🛑 Halting: No recruiter configurations found.', 'NORMAL');
    return;
  }

  const groupedConfigs = groupConfigsByRecruiter(flatRecruiterConfigs);
  const daysToSync = parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let potentialDeletions = 0;

  try {
    const syncStartDate = new Date(today);
    const syncEndDate = new Date(today);
    syncEndDate.setDate(today.getDate() + daysToSync);
    syncEndDate.setHours(23, 59, 59, 999);

    const allRecruiterEvents = {};
    for (const email in groupedConfigs) {
      allRecruiterEvents[email] = getBusyCalendarEvents(email, syncStartDate, syncEndDate);
    }
    const uniqueStageIds = [...new Set(flatRecruiterConfigs.map(c => c.stageId))];

    for (let i = 0; i <= daysToSync; i++) {
      const currentDate = new Date(today);
      currentDate.setDate(today.getDate() + i);
      if (isWeekend(currentDate)) continue;

      const dayString = Utilities.formatDate(currentDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      log('\n--- Analyzing Date: ' + dayString + ' ---', 'NORMAL');

      const dailySlotCache = new Map();
      uniqueStageIds.forEach(function(stageId) {
        const slots = getSlotsForSingleStageDay(config.FOUNTAIN_API_KEY, stageId, currentDate);
        slots.forEach(slot => dailySlotCache.set(slot.id, slot));
      });
      const allSlotsForDay = Array.from(dailySlotCache.values());

      for (const email in groupedConfigs) {
        const stageConfigs = groupedConfigs[email];
        const primaryConfig = stageConfigs[0];
        const allSlotTitles = stageConfigs.map(c => c.slotTitle.toLowerCase());

        const slotsForRecruiter = allSlotsForDay.filter(s => s.user_id && s.user_id === primaryConfig.fountainId);
        if (slotsForRecruiter.length === 0) continue;

        const { busyCalendarEventsToday } = getTodaysEvents(currentDate, allRecruiterEvents[email] || []);
        if (busyCalendarEventsToday.length === 0) continue;

        // --- This function now contains the new v11.4 logic ---
        const { slotsToDelete } = findConflictingSlots(
            config.FOUNTAIN_ORGANIZER_EMAIL,
            primaryConfig,
            allSlotTitles,
            slotsForRecruiter,
            busyCalendarEventsToday
        );

        if (slotsToDelete.length > 0) {
          potentialDeletions += slotsToDelete.length;
          slotsToDelete.forEach(function(slot) {
            log(' 	 -> [ANALYSIS] Slot ' + slot.id + ' (' + slot.start.toLocaleString() + ') for ' + email + ' WOULD BE DELETED.', 'NORMAL');
          });
        }
      } // End recruiter loop
    } // End day loop
  } catch (e) {
    log('❌ An error occurred during analysis. Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
  }

  log('\n✅ Analysis complete. Found ' + potentialDeletions + ' slot(s) that would be deleted. Total UrlFetch calls: ' + urlFetchCounter, 'NORMAL');
}


/**
* [MANUAL FUNCTION]
* Utility to fetch and log event organizers from configured calendars.
*/
function investigateEventOrganizers() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();
  SCRIPT_LOG_LEVEL = 'NORMAL';
  log('🚀 Starting Event Organizer Investigation...', 'NORMAL');

  if (typeof Calendar === 'undefined') {
    log('🛑 ERROR: The Advanced Google Calendar API service is not enabled.', 'NORMAL');
    return;
  }

  const flatRecruiterConfigs = loadRecruiterConfig(config.GOOGLE_SHEET_ID);
  if (!flatRecruiterConfigs || flatRecruiterConfigs.length === 0) {
    log('🛑 Halting: No recruiter configurations found.', 'NORMAL');
    return;
  }

  const groupedConfigs = groupConfigsByRecruiter(flatRecruiterConfigs);
  const daysToInvestigate = Math.min(parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 0, 7);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const email in groupedConfigs) {
    log('\n================== Investigating Calendar for: ' + email + ' ==================', 'NORMAL');
    try {
      const startDate = new Date(today);
      const endDate = new Date(today);
      endDate.setDate(today.getDate() + daysToInvestigate);
      endDate.setHours(23, 59, 59, 999);

      const events = Calendar.Events.list(email, {
        timeMin: startDate.toISOString(),
        timeMax: endDate.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      if (!events.items || events.items.length === 0) {
        log('No events found in this period for ' + email + '.', 'NORMAL');
        continue;
      }

      log('Found ' + events.items.length + ' total events to investigate for ' + email + '.', 'NORMAL');
      events.items.forEach(function(event) {
        const title = event.summary || '(No Title)';
        const organizerEmail = (event.organizer && event.organizer.email) ? event.organizer.email : 'N/A';
        log(' 	 -> Found Event: "' + title + '", Organizer: "' + organizerEmail + '"', 'NORMAL');
      });

    } catch (e) {
      log('❌ An error occurred while investigating calendar for ' + email + '. Error: ' + e.toString(), 'NORMAL');
      log(e.stack, 'DEBUG');
    }
  } // End loop
  log('\n✅ Investigation complete. Review logs to find the Fountain organizer email.', 'NORMAL');
}


// =====================================================================================
// ==================== NEW CALENDAR CONFLICT ANALYSIS FUNCTIONS =======================
// =====================================================================================

/**
 * [MANUAL FUNCTION - CORRECTED]
 * Analyzes recruiter calendars for overlapping events (conflicts) and
 * writes the findings to a new "Calendar Conflicts" tab.
 */
function findCalendarConflicts() {
  const scriptProperties = PropertiesService.getScriptProperties();
  const config = scriptProperties.getProperties();
  SCRIPT_LOG_LEVEL = 'NORMAL';
  log('🚀 Starting Calendar Conflict Analysis...', 'NORMAL');

  if (typeof Calendar === 'undefined') {
    log('🛑 ERROR: The Advanced Google Calendar API service is not enabled.', 'NORMAL');
    return;
  }

  const sheetId = config.GOOGLE_SHEET_ID;
  if (!sheetId || sheetId.includes('YOUR_')) {
    log('🛑 ERROR: GOOGLE_SHEET_ID is not configured.', 'NORMAL');
    return;
  }

  const flatRecruiterConfigs = loadRecruiterConfig(sheetId);
  if (!flatRecruiterConfigs || flatRecruiterConfigs.length === 0) {
    log('🛑 Halting: No recruiter configurations found.', 'NORMAL');
    return;
  }

  const uniqueRecruiterEmails = [...new Set(flatRecruiterConfigs.map(c => c.email))];
  const daysToSync = parseInt(config.DAYS_TO_SYNC_IN_FUTURE, 10) || 7;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const syncEndDate = new Date(today);
  syncEndDate.setDate(today.getDate() + daysToSync);
  syncEndDate.setHours(23, 59, 59, 999);

  let allConflicts = [];

  for (const email of uniqueRecruiterEmails) {
    log('\n--- Analyzing Calendar for: ' + email + ' ---', 'NORMAL');
    try {
      const allEvents = getAllRelevantCalendarEvents(email, today, syncEndDate);
      log(' 	-> Found ' + allEvents.length + ' relevant events to check.', 'DEBUG');

      const conflicts = findOverlapsInEvents(allEvents);
      log(' 	-> Found ' + conflicts.length + ' overlapping conflict(s) for ' + email + '.', 'NORMAL');

      if (conflicts.length > 0) {
        const conflictsWithRecruiter = conflicts.map(c => ({
          recruiter: email,
          ...c
        }));
        allConflicts.push(...conflictsWithRecruiter);
      }
    } catch (e) {
      log('❌ Error analyzing calendar for ' + email + ': ' + e.toString(), 'NORMAL');
      log(e.stack, 'DEBUG');
    }
  } // End recruiter loop

  writeConflictsToSheet(sheetId, allConflicts);
  log('\n✅ Calendar conflict analysis complete. Found ' + allConflicts.length + ' total conflicts.', 'NORMAL');
}

/**
* [HELPER for findCalendarConflicts]
 * Fetches and filters Google Calendar events to identify all potentially
 * conflicting events (e.g., accepted, tentative, needsAction, owned).
 */
function getAllRelevantCalendarEvents(calendarId, startDate, endDate) {
  try {
    const HOLIDAY_KEYWORDS = ['holiday', 'annual leave', 'out of office', 'ooo', 'leave', 'pto'];

    const eventsResponse = Calendar.Events.list(calendarId, {
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: 'startTime' // Critical: must be sorted
    });

    const events = eventsResponse.items;
    if (!events) return [];

    // --- THIS IS THE CORRECTED LINE ---
    log('--- Analyzing ' + events.length + ' GCal events for ' + calendarId + '... ---', 'DEBUG');

    const relevantEvents = events.filter(function(event) {
      const title = event.summary || '';
      const lowerCaseTitle = title.toLowerCase();

      const self = (event.attendees || []).find(function(attendee) { return attendee.self; });
      const status = self ? self.responseStatus : 'needsAction';
      const isAllDay = !!event.start.date;

      log(' 	-> Checking Event: "' + title + '", All-Day: ' + isAllDay + ', Status: ' + status, 'DEBUG');

      // 1. Discard declined
      if (status === 'declined') {
        log(' 	 	 - Decision: IGNORE (Declined event)', 'DEBUG');
        return false;
      }
      // 2. Discard "Working location:"
      if (title.includes('Working location:')) {
        log(' 	 	 - Decision: IGNORE (Working Location)', 'DEBUG');
        return false;
      }
      // 3. Handle all-day
      if (isAllDay) {
        const isHoliday = HOLIDAY_KEYWORDS.some(k => k.toLowerCase().includes(k));
        if (isHoliday || lowerCaseTitle.includes('out of office')) {
          log(' 	 	 - Decision: KEEP (Holiday/OOO All-day event)', 'DEBUG');
          return true;
        } else {
          log(' 	 	 - Decision: IGNORE (Non-holiday All-day event)', 'DEBUG');
          return false;
        }
      }
      // 4. Keep everything else (Accepted, Tentative, NeedsAction, Owned)
      log(' 	 	 - Decision: KEEP (Relevant, non-all-day event)', 'DEBUG');
      return true;
    });

    log('--- Kept ' + relevantEvents.length + ' relevant events for conflict check. ---', 'DEBUG');

    return relevantEvents.map(function(event) {
      return {
        title: event.summary || '',
        start: new Date((event.start.dateTime || event.start.date)),
        end: new Date((event.end.dateTime || event.end.date))
      };
    });
  } catch (e) {
    log('❌ Error fetching relevant calendar events for ' + calendarId + ': ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
    return [];
  }
}

/**
 * [HELPER for findCalendarConflicts]
 * Finds overlapping events from a pre-sorted list of events.
 */
function findOverlapsInEvents(sortedEvents) {
  const conflicts = [];
  const targetStrings = ["Interview Booked (Amy)", "AI booked Interview", "Book Interview (Tel)"]; // <-- ADDED "Book Interview (Tel)"

  if (!sortedEvents || sortedEvents.length < 2) {
    return conflicts;
  }

  for (let i = 0; i < sortedEvents.length - 1; i++) {
    const eventA = sortedEvents[i];

    for (let j = i + 1; j < sortedEvents.length; j++) {
      const eventB = sortedEvents[j];

      if (eventA.end > eventB.start) {
        // --- UPDATED FILTERING LOGIC ---
        const titleA = eventA.title || '';
        const titleB = eventB.title || '';

        const titleAMatches = targetStrings.some(s => titleA.includes(s));
        const titleBMatches = targetStrings.some(s => titleB.includes(s));
        const isTargetConflict = titleAMatches && titleBMatches; // <-- REVERTED from || to &&

        if (isTargetConflict) {
          log(' 	-> TARGET CONFLICT DETECTED: "' + eventA.title + '" overlaps "' + eventB.title + '"', 'NORMAL');
          conflicts.push({
            event1_title: eventA.title,
            event1_start: eventA.start,
            event2_title: eventB.title,
            event2_start: eventB.start
          });
        } else {
          log(' 	-> (Ignoring non-target overlap between: "' + titleA + '" and "' + titleB + '")', 'DEBUG');
        }
      } else {
        break; // Optimization
      }
    }
  }
  return conflicts;
}

/**
 * [HELPER for findCalendarConflicts]
 * Writes an array of conflict objects to a specific "Calendar Conflicts" tab.
 */
function writeConflictsToSheet(sheetId, conflicts) {
  const sheetName = 'Calendar Conflicts';
  try {
    const ss = SpreadsheetApp.openById(sheetId);
    let sheet = ss.getSheetByName(sheetName);

    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
      log(' 	-> Created new sheet: "' + sheetName + '"', 'NORMAL');
    } else {
      log(' 	-> Found existing sheet: "' + sheetName + '"', 'NORMAL');
    }

    sheet.clear();
    const headers = [
      "Report Generated", "Recruiter", "Event 1 Title",
      "Event 1 Start Time", "Event 2 Title", "Event 2 Start Time"
    ];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);

    if (conflicts.length === 0) {
      log(' 	-> No conflicts to write to the sheet.', 'NORMAL');
      sheet.getRange(2, 1).setValue('No conflicts found.');
      return;
    }

    const now = new Date();
    const outputData = conflicts.map(c => [
      now, c.recruiter, c.event1_title, c.event1_start,
      c.event2_title, c.event2_start
    ]);

    sheet.getRange(2, 1, outputData.length, headers.length).setValues(outputData);
    
    for (let i = 1; i <= headers.length; i++) {
      sheet.autoResizeColumn(i);
    }
    
    log(' 	-> Successfully wrote ' + conflicts.length + ' conflict(s) to "' + sheetName + '"', 'NORMAL');

  } catch (e) {
    log('❌ CRITICAL ERROR: Could not write to Google Sheet "' + sheetName + '". Error: ' + e.toString(), 'NORMAL');
    log(e.stack, 'DEBUG');
  }
}
