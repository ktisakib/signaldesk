# Sample broadcast playlist

The 20 programs in `media/playlist.json` come from NASA's official YouTube channels. Each program was matched to an official NASA source page that permits downloading and sharing the complete video. The manifest records the source, permission page, creator, attribution, actual download method, duration, resolution, file size and SHA-256 for each local file.

These are permissions for complete programs. Several include music or stock footage licensed to NASA for the finished production. Those components are not separately licensed for extraction or remixing, and the complete productions are not being labelled public domain or Creative Commons. Keep the original narration, music and credits. Do not cut programs, remove credits, add overlays or present NASA as endorsing SignalDesk or the broadcaster.

NASA's [media usage guidelines](https://www.nasa.gov/nasa-brand-center/images-and-media/) explain the conditions concerning third-party works, attribution, identifiable people and endorsement. NASA SVS also describes its [general reuse policy](https://svs.gsfc.nasa.gov/help/); the item-specific permission pages in the manifest control this particular selection.

The local files retain the downloaded YouTube H.264/AAC video and audio. No frames or audio were cut, and no overlays were added. Resolution varies by the creator's published aspect ratio, up to 720 pixels tall. Any future official-source fallback is recorded separately in `downloadMethod`, with the YouTube failure reason, and converted without cropping or shortening the program.

## Verify or download again

Use Python 3.11 or newer in a virtual environment with the official `yt-dlp[default]` package. This download was made with yt-dlp 2026.10.26. FFmpeg, FFprobe and Node must be on PATH. No browser cookies, account credentials, DRM bypasses or verification bypasses are used.

```sh
python -m pip install "yt-dlp[default]==2026.10.26"
python scripts/download-playlist.py --verify
python scripts/download-playlist.py
python -m unittest discover -s tests -p '*_test.py'
```

The downloader keeps valid local files and uses at most three parallel downloads. It checks HTTPS source hosts, the YouTube creator, compatible codecs, full-program duration and local file hashes. It attempts the corresponding official YouTube video first. If that request fails, it can use only the reviewed original download from NASA's own SVS server. Temporary files are removed after each attempt.

The manifest's file paths are relative to the repository. With the repository's `media` directory mounted at `/media`, a path such as `media/videos/example.mp4` becomes `/media/videos/example.mp4` inside the streaming container. The video files are runtime media, separate from application source.

## Programs and attribution

Every item is credited to NASA and the production team identified at its source page. The manifest retains the producer names and available music credits; the original program retains its own on-screen credits. The table below links to the exact YouTube publication and the corresponding official rights evidence.

| # | Complete program | Runtime | Creator | YouTube | Rights evidence |
| - | - | - | - | - | - |
| 1 | Antarctic Sea Ice Hits Annual Minimum, Second Lowest On Record | 1:05 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=oqOiu-uQ8Ew) | [NASA permission](https://svs.gsfc.nasa.gov/14538/) |
| 2 | Our Oceans from Space | 2:06 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=v3dO7PhYas4) | [NASA permission](https://svs.gsfc.nasa.gov/14567/) |
| 3 | Landsat 9 At Work | 3:16 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=Af8gJ0RVyaY) | [NASA permission](https://svs.gsfc.nasa.gov/13889/) |
| 4 | A Trip Through Time With Landsat 9 | 4:46 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=up9oDz49QXI) | [NASA permission](https://svs.gsfc.nasa.gov/13890/) |
| 5 | Juno Discovers Mars’ Dust Storms Fill Solar System (🎵 by Vangelis) | 1:45 | NASA Goddard | [Watch](https://youtu.be/ve0jLXEzFXE) | [NASA permission](https://svs.gsfc.nasa.gov/13821/) |
| 6 | SWOT Mission Unlocks a New View of Our Waterways | 4:37 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=42PUJiJC65Q) | [NASA permission](https://svs.gsfc.nasa.gov/14990/) |
| 7 | NASA Flew Over a Fire — to Better Understand Future Ones | 12:30 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=QFfZe9Zq2mY) | [NASA permission](https://svs.gsfc.nasa.gov/14894/) |
| 8 | NASA + Smithsonian and Greenhouse Gases | 4:17 | NASA Scientific Visualization Studio | [Watch](https://www.youtube.com/watch?v=gz1JwUTL6dc) | [NASA permission](https://svs.gsfc.nasa.gov/14696/) |
| 9 | NASA and Fire | 3:13 | NASA Scientific Visualization Studio | [Watch](https://youtu.be/RFz3T5059Jw) | [NASA permission](https://svs.gsfc.nasa.gov/14606/) |
| 10 | NASA and Biodiversity | 2:50 | NASA Scientific Visualization Studio | [Watch](https://youtu.be/XLWZUZh-Kgc) | [NASA permission](https://svs.gsfc.nasa.gov/14507/) |
| 11 | NASA Has Eyes On The Atlantic Hurricane Season | 2:37 | NASA Goddard | [Watch](https://youtu.be/6X0puPAMe74) | [NASA permission](https://svs.gsfc.nasa.gov/13216/) |
| 12 | NASA and Sea Level Change | 2:19 | NASA Scientific Visualization Studio | [Watch](https://www.youtube.com/watch?v=FDSoZYUw6Bk) | [NASA permission](https://svs.gsfc.nasa.gov/14713/) |
| 13 | Parker Solar Probe: Humanity’s Closest Encounter with the Sun | 5:42 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=c80TzqNoqMg) | [NASA permission](https://science.nasa.gov/science-research/heliophysics/nasas-parker-solar-probe-makes-history-with-closest-pass-to-sun/) |
| 14 | NASA’S PUNCH Mission | 2:22 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=bOi8fDGtmZo) | [NASA permission](https://science.nasa.gov/science-research/heliophysics/nasas-punch-mission-to-revolutionize-view-of-solar-wind/) |
| 15 | How NASA Uses Simple Technology to Track Lunar Missions | 1:32 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=L2TMQpw76iQ) | [NASA permission](https://www.nasa.gov/technology/how-nasa-uses-simple-technology-to-track-lunar-missions/) |
| 16 | NASA Mapping Critical Minerals | 3:17 | NASA Scientific Visualization Studio | [Watch](https://www.youtube.com/watch?v=tikxjIqNpmU) | [NASA permission](https://svs.gsfc.nasa.gov/60001/) |
| 17 | NASA: Helping Communities Protect Drinking Water | 2:50 | NASA Scientific Visualization Studio | [Watch](https://www.youtube.com/watch?v=1zLlbiBLFRY) | [NASA permission](https://svs.gsfc.nasa.gov/60002/) |
| 18 | How NASA Data Stabilizes Global Markets | 2:23 | NASA Scientific Visualization Studio | [Watch](https://www.youtube.com/watch?v=kq2YJ-BvN6E) | [NASA permission](https://svs.gsfc.nasa.gov/60003/) |
| 19 | The Geocenter of the Earth Is Changing (And Why That Matters) | 3:27 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=54AgCRhdwvo) | [NASA permission](https://svs.gsfc.nasa.gov/14121/) |
| 20 | NASA Satellite Measures Human Impact in Water Storage | 2:48 | NASA Goddard | [Watch](https://www.youtube.com/watch?v=5D7pIijH-4M) | [NASA permission](https://svs.gsfc.nasa.gov/13824/) |

Verified on November 1, 2026: **20 complete programs, 1:09:43 total, 766,978,846 bytes**. Every current entry has `downloadMethod: youtube-yt-dlp`; no original-source fallback was needed.
