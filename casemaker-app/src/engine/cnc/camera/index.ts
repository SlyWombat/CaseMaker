/**
 * The camera calibration target (#189) — the half that needs no camera.
 *
 * `targetSpec` is the layout in mm, `targetArt` renders it as a printable SVG, and `fiducialJob`
 * turns the same layout into the engrave job that mills the crosses. One arithmetic, three
 * consumers, so the printed pocket and the milled cross cannot drift apart.
 *
 * SINCE #286 the camera's own half is here too, and it is still machine-free: `capture` is the
 * protocol a frame source is driven through (start → drop the stale replay → keep N → close), and
 * `calibrate` is the stitch/re-validation maths over known feature positions. Neither imports a
 * socket or a CV library; the live WebSocket source and a real capture are bench work (#767).
 */

export * from './targetSpec';
export * from './targetArt';
export * from './fiducialJob';
export * from './capture';
export * from './calibrate';
