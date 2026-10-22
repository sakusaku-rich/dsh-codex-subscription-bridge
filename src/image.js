// Image request targeting for the subscription endpoint.
//
// `requestImageDimensions` and `longEdgeDimensions` are ported from
// @deepseek-ai/dsh-attachment 0.2.1-rc.2 (MIT License). DeepSeek imports that
// package directly, but vendoring these two pure functions avoids a new host
// resolution dependency while keeping the identical projection math. Both
// functions were re-read against the pinned package on 2026-10-23 and are
// unchanged from the earlier port.

export const REQUEST_IMAGE_PIXEL_BUDGET = 4 * 1024 * 1024;
export const REQUEST_IMAGE_LONG_EDGE = 4096;
export const REQUEST_IMAGE_MAX_BYTES = 1024 * 1024;
export const REQUEST_IMAGE_OFFLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const REQUEST_IMAGE_OFFLOAD_BYTE_QUANTUM = 10 * 1024 * 1024;
export const REQUEST_IMAGE_ATTACHMENT_MAX_BYTES = 32 * 1024 * 1024;

/**
* Compute aspect-preserving integer dimensions within an exact pixel budget.
* @param width - positive source width.
* @param height - positive source height.
* @param maxPixels - positive pixel budget for the request image.
* @returns the target dimensions; a budget at or above the source pixels returns the source unchanged.
*/
export function requestImageDimensions(width, height, maxPixels) {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)));
  if (scale === 1) return { width, height };
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale));
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1;
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width));
    }
    return { width: projectedWidth, height: projectedHeight };
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale));
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1;
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height));
  }
  return { width: projectedWidth, height: projectedHeight };
}

/**
* Compute aspect-preserving integer dimensions with an exact long edge; the
* short edge rounds to the nearest pixel, as an encoder resize by the
* long edge alone.
* @param width - positive source width.
* @param height - positive source height.
* @param longEdge - positive target for the longer source edge.
* @returns the target dimensions; a long edge at or above the source returns the source unchanged.
*/
export function longEdgeDimensions(width, height, longEdge) {
  if (longEdge >= Math.max(width, height)) return { width, height };
  return width >= height
    ? { width: longEdge, height: Math.max(1, Math.round(longEdge * height / width)) }
    : { width: Math.max(1, Math.round(longEdge * width / height)), height: longEdge };
}

/**
* Request-image target for one attachment, mirroring the DeepSeek adapter
* composition: pixel-budget projection first, then a long-edge recomputation
* from the source dimensions when the projection still exceeds 4096 pixels.
* The pixel budget matches the Codex image policy in
* @deepseek-ai/dsh-llm-pi-ai; the long-edge step is a conservative addition
* not present in that adapter.
* @param width - positive source width.
* @param height - positive source height.
* @returns request dimensions with the encoded-image byte ceiling.
*/
export function requestImageTarget(width, height) {
  const projected = requestImageDimensions(width, height, REQUEST_IMAGE_PIXEL_BUDGET);
  const longEdge = Math.max(projected.width, projected.height) > REQUEST_IMAGE_LONG_EDGE
    ? longEdgeDimensions(width, height, REQUEST_IMAGE_LONG_EDGE) : projected;
  return { ...longEdge, maxBytes: REQUEST_IMAGE_MAX_BYTES };
}

/**
* Approximate the subscription vision cost with the OpenAI high-detail tile
* formula (512px tiles, 85 base plus 170 per tile). This is a conservative
* host-budgeting hint only; the subscription backend's real accounting is not
* verified.
* @param width - request-image width in pixels.
* @param height - request-image height in pixels.
* @returns estimated vision tokens.
*/
export function estimateVisionTokens(width, height) {
  return 85 + 170 * Math.ceil(width / 512) * Math.ceil(height / 512);
}

/**
* Serialize one request image as a data URL the Responses endpoint accepts.
* @param mediaType - attachment media type.
* @param base64 - exact base64 request-image payload.
* @returns the data URL wire value.
*/
export function imageDataUrl(mediaType, base64) {
  return `data:${mediaType};base64,${base64}`;
}