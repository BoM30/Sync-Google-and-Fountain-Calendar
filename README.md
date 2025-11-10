# Fountain Proactive Slot Creator

## Description

This Google Apps Script proactively creates and deletes interview slots in Fountain to ensure the schedule is a perfect reflection of a recruiter's Google Calendar. It is designed to be highly efficient and robust, using a hybrid sync model to minimize API calls and ensure accurate scheduling.

## Core Logic

### Hybrid Sync Model

The script uses a two-pronged approach to keep the calendars in sync:

*   **Full Sync (`syncCalendars_Full`):** This function runs once nightly during configurable "Quiet Hours." It performs a complete check of the configured recruiters' calendars for the upcoming number of days (also configurable) and updates Fountain accordingly. This serves as a master reset to ensure everything is in a known good state.
*   **Delta Sync (`syncCalendars_Delta`):** This function runs frequently (e.g., every 15 minutes) outside of Quiet Hours. It only syncs changes (deltas) that have occurred since the last sync, making it extremely fast and efficient. This is achieved by caching the state of the Google Calendar and comparing it to the current state on each run.

### "Busy is Busy" Logic

The script follows a simple but powerful rule: if a time slot in a recruiter's Google Calendar is busy, then that time should not be available in Fountain. This "Busy is Busy" logic correctly flags unbooked Fountain slots for deletion if they overlap with *any* busy Google Calendar event, preventing double bookings and ensuring the recruiter's availability is accurately reflected.

## Setup

1.  **Enable the Google Calendar API:**
    *   In the script editor, go to `Services` > `+ Add a service`.
    *   Select `Google Calendar API` and click `Add`.

2.  **Configure Script Properties:**
    *   Open the `Code.gs` file and find the `setupScriptProperties` function.
    *   Fill in the required values in the `properties` object:
        *   `FOUNTAIN_API_KEY`: Your API key for the Fountain platform.
        *   `GOOGLE_SHEET_ID`: The ID of the Google Sheet where you will configure the recruiters.
        *   `DAYS_TO_SYNC_IN_FUTURE`: The number of days in the future to sync.
        *   `LOGGING_LEVEL`: The desired logging level (`NONE`, `NORMAL`, or `DEBUG`).
        *   `FOUNTAIN_ORGANIZER_EMAIL`: The service account email used by Fountain to create events. You can find this using the `investigateEventOrganizers()` utility function.
        *   `QUIET_HOURS_START` and `QUIET_HOURS_END`: The start and end times for the nightly Full Sync.
    *   Run the `setupScriptProperties` function once to save these settings.

3.  **Set up the Google Sheet:**
    *   Create a Google Sheet with the ID you specified in the script properties.
    *   The first sheet in the document should have the following header columns:
        *   `Google_Calendar_Email`
        *   `Fountain_User_ID`
        *   `Work_Start_Time` (in HH:MM format)
        *   `Work_End_Time` (in HH:MM format)
        *   `Slot_Length_Minutes`
        *   `Stage_IDs` (comma-separated if multiple)
        *   `Slot_Title`
    *   Add a new sheet named `Delete Tasks` with the following header columns:
        *   `Fountain_User_ID`
        *   `Stage_IDs` (comma-separated if multiple)

## Automated Functions

*   **`syncCalendars_Full()`:**
    *   This function should be set up to run on a time-based trigger once per day during the configured Quiet Hours.
*   **`syncCalendars_Delta()`:**
    *   This function should be set up to run on a time-based trigger every 15-30 minutes outside of the configured Quiet Hours.

## Manual Utility Functions

The script also includes several manual utility functions that can be run as needed by an administrator:

*   **`bulkDeleteSlots()`:** Reads from the "Delete Tasks" sheet and deletes all unbooked Fountain slots for the specified user and stage(s).
*   **`analyzeCalendarForFountainIdentifier()`:** Analyzes the calendar for potential issues with the Fountain event identifier.
*   **`analyzePotentialDeletions()`:** Runs a simulation of the `syncCalendars_Full` logic and logs potential deletions without actually performing them.
*   **`investigateEventOrganizers()`:** Fetches and logs event organizers from the configured calendars to help find the correct `FOUNTAIN_ORGANIZER_EMAIL`.
*   **`findCalendarConflicts()`:** Analyzes recruiter calendars for overlapping events and writes the findings to a "Calendar Conflicts" tab in the configuration sheet.

## Troubleshooting

*   **`401 Unauthorized` errors:** This usually indicates an invalid or expired `FOUNTAIN_API_KEY`.
*   **Slots not being created/deleted:**
    *   Check the script logs for any errors.
    *   Ensure the `GOOGLE_SHEET_ID` is correct and the sheet is formatted correctly.
    *   Verify that the recruiter configurations are correct and complete.
    *   Make sure the triggers are set up correctly and are not failing.
*   **`Advanced Google Calendar API service is not enabled`:** Follow the instructions in the Setup section to enable the API.
