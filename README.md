# Mod Randomizer
[Get this extension on the opera addons store](https://addons.opera.com/en/extensions/details/mod-randomizer/)

This is a mod randomizer for Opera GX, so you don't have to manually disable and then choose which mod to enable.

Click Randomize to choose a mod. With uninstall/reinstall enabled, click the Reinstall button and accept Opera's confirmation; the store page opens after successful removal. With reinstall disabled, the mod is enabled normally.

Reinstall enables all checkmarks, so it's recommended to keep it on.

You can manually switch mods like this, but it's possible to automate it with the other options: you can randomize when browser restarts, and randomize periodically.

Shuffle bag is enabled by default under **Advanced Settings**. It uses every available mod once before repeating, remembers progress across browser restarts, and keeps a separate bag for each profile and for randomize-all mode. Turning it off restores ordinary random selection; toggling it starts fresh bags.

You can customize which mods will be disabled and enabled, using the mod profiles.

(Disclaimer: Most of the code was written by ChatGPT and Claude)





## Development

Run `npm test` with Node.js 22 or newer. No dependency installation is required. See [TESTING.md](TESTING.md) for automated coverage and Opera GX integration checks.

