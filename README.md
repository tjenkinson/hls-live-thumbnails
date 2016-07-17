[![npm version](https://badge.fury.io/js/hls-live-thumbnails.svg)](https://badge.fury.io/js/hls-live-thumbnails)
# HLS Live Thumbnails
A service which will generate thumbnails from a live HLS stream.

Can be either used as a library or run as a service and controlled with http requests.

### ThumbnailGenerator
This will generate thumbnails from a HLS stream and emit a `newThumbnail` event whenever a thumbnail is generated.

### SimpleThumbnailGenerator
This uses `ThumbnailGenerator` but will also remove thumbnails when their segments are removed from the playlist, or when the playlist no longer exists.
You can configure a time to wait before removing thumbnails after their segments are removed using the `expireTime` option.

### Service
You can run this as a service which will expose a http API for control.
These are the options:
- **port**: The port to listen on. Defaults to 8080.
- **outputDir**: The directory to place the thumbnails and manifest file.
- **tempDir**: A directory to use for temporary files. (Optional)
- **secret**: A string which must be provided in a "x-secret" header for each request.
- **expireTime**: The time in seconds to keep thumbnails for before deleting them, once their segments have left the playlist. Defaults to 0.
- **interval**: The default interval between thumbnails. If omitted the interval will be calculated automatically using `targetThumbnailCount`.
- **initialThumbnailCount**: The default number of thumbnails to generate initially, from the end of the stream. If ommitted defaults to taking thumbnails for the entire stream.
- **targetThumbnailCount**: The default number of thumbnails that should be generated over the duration of the stream. Defaults to 30. This will be recalculated if the stream duration changes.
- **width**: The default width of the thumbnails to generate (px). If omitted this will be calculated automatically from the height, or default to 150.
- **height**: The default height of the thumbnails to generate (px). If omitted this will be calculated automatically from the width.

E.g. `hls-live-thumbnails --secret "super-secret" --targetThumbnailCount 20 --width 300`

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

The response is `{id: <id which represents this generator>}`

The manifest file will be called "thumbnails-[id].json".

##### GET /v1/generators/:id
Get information about the provided generator. A 404 will be returned if a generator no longer exists, e.g. if all thumbnails have expired.

The response is `{ended: <true if the stream has ended, no more thumbnails will be generated>}`

##### DELETE /v1/generators/:id
Terminate the generator with `id`. All of its thumbnails will be removed.

#### Manifest File Format
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
