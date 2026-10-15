import importlib.util, os, pathlib, tempfile, unittest
from unittest.mock import patch
with tempfile.TemporaryDirectory() as home:
 os.environ.update(WIZARD_MUSIC_HUB_HOME=home,WIZARD_MUSIC_LIBRARY=home,WIZARD_MUSIC_ONLINE='0')
 spec=importlib.util.spec_from_file_location('music_hub',pathlib.Path(__file__).parents[1]/'hub/hub.py')
 hub=importlib.util.module_from_spec(spec)
 import sys
 sys.modules[spec.name]=hub
 spec.loader.exec_module(hub)
 class OfflineBoundary(unittest.TestCase):
  def test_audio_never_spawns_downloader(self):
   with patch.object(hub.subprocess,'run',side_effect=AssertionError('egress')) as run:
    with self.assertRaises(LookupError):hub.fetch_audio('aaaaaaaaaaa')
    hub.prefetch('yt:aaaaaaaaaaa')
    run.assert_not_called()
  def test_art_never_fetches_network(self):
   with patch.object(hub.urllib.request,'urlopen',side_effect=AssertionError('egress')) as fetch:
    self.assertIsNone(hub.art_bytes('yt:aaaaaaaaaaa'))
    fetch.assert_not_called()
 unittest.main()
