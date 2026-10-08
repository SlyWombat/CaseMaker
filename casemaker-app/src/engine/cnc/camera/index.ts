/**
 * The camera calibration target (#189) — the half that needs no camera.
 *
 * `targetSpec` is the layout in mm, `targetArt` renders it as a printable SVG, and `fiducialJob`
 * turns the same layout into the engrave job that mills the crosses. One arithmetic, three
 * consumers, so the printed pocket and the milled cross cannot drift apart.
 */

export * from './targetSpec';
export * from './targetArt';
export * from './fiducialJob';
