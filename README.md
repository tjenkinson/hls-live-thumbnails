[![npm version](https://img.shields.io/npm/v/hls-live-thumbnails.svg?maxAge=2592000)](https://www.npmjs.com/package/hls-live-thumbnails)
[![npm](https://img.shields.io/npm/dm/hls-live-thumbnails.svg?maxAge=2592000)](https://www.npmjs.com/package/hls-live-thumbnails)
[![npm](https://img.shields.io/npm/dt/hls-live-thumbnails.svg?maxAge=2592000)](https://www.npmjs.com/package/hls-live-thumbnails)
# HLS Live Thumbnails
A service which will generate thumbnails from a live HLS stream.

Can be either used as a library, run as a service and controlled with http requests, or standalone for handling a single stream.

### Installation
- Install [ffmpeg](https://ffmpeg.org/download.html) globally. You should be able to simply `ffmpeg` at a command prompt.
- `npm install -g hls-live-thumbnails` to install globally.

### Demo
Run `hls-live-thumbnails https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8`.

### ThumbnailGenerator
This will generate thumbnails from a HLS stream and emit a `newThumbnail` event whenever a thumbnail is generated.

### SimpleThumbnailGenerator
This uses `ThumbnailGenerator` but will also remove thumbnails when their segments are removed from the playlist, or when the playlist no longer exists.
You can configure a time to wait before removing thumbnails after their segments are removed using the `expireTime` option.
This generates a JSON manifest file with information about the generated thumbnails.


### Service & Standalone
You can run this as a service which will expose a http API for control, or standalone.

If run standalone the program will terminate with exit code 0 once all thumbnails have been generated and the stream has ended, or 1 if there was an error.

These are the options:
- **url**: The URL of the stream. If specified 'port' or 'secret' must not be provided.
- **manifestFileName**:  The name of the manifest file. Only valid with 'url' option and defaults to 'thumbnails.json'.
- **outputNamePrefix**: The string to be prefixed to the thumbnail file names. Only valid with 'url' option and defaults to a hash of the stream URL.
- **port**: The port to listen on. Defaults to 8080, unless running standalone.
- **pingInterval**: If a ping request isn't made every 'pingInterval' seconds then thumbnail generation will stop. Defaults to disabled.
- **clearOutputDir**: If provided the output directory will be emptied when the program starts.
- **outputDir**: The directory to place the thumbnails and manifest file.
- **tempDir**: A directory to use for temporary files. (Optional)
- **secret**: A string which must be provided in a "x-secret" header for each request.
- **expireTime**: The time in seconds to keep thumbnails for before deleting them, once their segments have left the playlist. Defaults to 0.
- **interval**: The default interval between thumbnails. If omitted the interval will be calculated automatically using `targetThumbnailCount`.
- **initialThumbnailCount**: The default number of thumbnails to generate initially, from the end of the stream. If ommitted defaults to taking thumbnails for the entire stream.
- **targetThumbnailCount**: The default number of thumbnails that should be generated over the duration of the stream. Defaults to 30. This will be recalculated if the stream duration changes.
- **width**: The default width of the thumbnails to generate (px). If omitted this will be calculated automatically from the height, or default to 150.
- **height**: The default height of the thumbnails to generate (px). If omitted this will be calculated automatically from the width.
- **ignorePlaylist404**: Do not abort immediately if the playlist response is a 404. Defaults to false.
- **playlistRetryCount**: The number of times to retry downloding the playlist on an error. Defaults to 2. Can be -1 for unlimited retries.

E.g. Service: `hls-live-thumbnails --secret "super-secret" --targetThumbnailCount 20 --width 300`
E.g. Standalone: `hls-live-thumbnails https://devimages.apple.com.edgekey.net/streaming/examples/bipbop_4x3/bipbop_4x3_variant.m3u8  --width 300`

#### API
##### POST /v1/start
Start generating thumbnails for a stream.

The following parameters are allowed:
- **url**: The playlist URL. (Requierd)
- **width**: Override `width` option. (Optional)
- **height**: Override `height` option. (Optional)
- **interval**: Override `interval` option. (Optional)
- **initialThumbnailCount**: Override `initialThumbnailCount` option. (Optional)
- **targetThumbnailCount**: Override `targetThumbnailCount` option. (Optional)
- **id**: Provide an alpha-numeric ID for this generator. (Optional. Will be generated automatically if not provided.)

The response is `{id: <id which represents this generator>}`

The manifest file will be called "thumbnails-[id].json".

##### GET /v1/generators/:id
Get information about the provided generator. A 404 will be returned if a generator no longer exists, e.g. if all thumbnails have expired.

The response is `{ended: <true if the stream has ended, no more thumbnails will be generated>}`

This counts as a 'ping'. Look at the 'pingInterval' option.

##### DELETE /v1/generators/:id
Terminate the generator with `id`. All of its thumbnails will be removed.

### Manifest File Format
This is the structure of the manifest file. It will be called "thumbnails-[id].json".
```
{
  "ended":<true if the stream has ended>,
  "segments": [{
    "sn": <segment sequence number>,
    "removalTime": <The time the segment was removed from the playlist, or null>,
    "thumbnails": [
      {
        time: <time into the segment that the thumbnail was taken (seconds)>,
        name: <thumbnail filename>
      },
      {
        time: <time into the segment that the thumbnail was taken (seconds)>,
        name: <thumbnail filename>
      }
    ]
  }]
}
```
