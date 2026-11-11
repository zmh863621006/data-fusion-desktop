"""Build-machine download helper; never runs on end-user computers."""
import concurrent.futures
import hashlib
import pathlib
import sys
import time
import urllib.request

DIRECTORY = pathlib.Path('.tmp/windows-prerequisites')
URL = 'https://catalog.s.download.windowsupdate.com/msdownload/update/software/svpk/2011/02/windows6.1-kb976932-x64_74865ef2562006e51d7f9333b4a8d45b7a749dab.exe'
SIZE = 947070088
CHUNK = 4 * 1024 * 1024
SHA1 = '74865ef2562006e51d7f9333b4a8d45b7a749dab'
NAME = 'SP1'
FILE = 'windows6.1-KB976932-X64.exe'
if len(sys.argv) > 1:
    NAME = sys.argv[1]
    if NAME == 'SSU':
        URL = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/secu/2019/03/windows6.1-kb4490628-x64_d3de52d6987f7c8bdc2c015dca69eac96047c76e.msu'
        SIZE = 9543846
        SHA1 = 'd3de52d6987f7c8bdc2c015dca69eac96047c76e'
        FILE = 'windows6.1-KB4490628-x64.msu'
    elif NAME == 'SHA2':
        URL = 'https://catalog.s.download.windowsupdate.com/c/msdownload/update/software/secu/2019/09/windows6.1-kb4474419-v3-x64_b5614c6cea5cb4e198717789633dca16308ef79c.msu'
        SIZE = 55853327
        SHA1 = 'b5614c6cea5cb4e198717789633dca16308ef79c'
        FILE = 'windows6.1-KB4474419-v3-x64.msu'
    else:
        raise ValueError('Unknown prerequisite')


def download(index):
    start = index * CHUNK
    end = min(start + CHUNK, SIZE) - 1
    output = DIRECTORY / (NAME.lower() + '-ranges') / str(index)
    if output.exists() and output.stat().st_size == end - start + 1:
        return output.stat().st_size
    for attempt in range(4):
        try:
            request = urllib.request.Request(URL + '?datafusion-part=%d' % index,
                                             headers={'Range': 'bytes=%d-%d' % (start, end)})
            with urllib.request.urlopen(request, timeout=35) as source:
                assert source.status == 206
                assert source.headers.get('Content-Range') == 'bytes %d-%d/%d' % (start, end, SIZE)
                content = source.read(CHUNK + 1)
            assert len(content) == end - start + 1
            output.write_bytes(content)
            return len(content)
        except Exception:
            if attempt == 3:
                raise
            time.sleep(1 + attempt)


if __name__ == '__main__':
    (DIRECTORY / (NAME.lower() + '-ranges')).mkdir(parents=True, exist_ok=True)
    count = (SIZE + CHUNK - 1) // CHUNK
    completed = 0
    last = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=24) as pool:
        for future in concurrent.futures.as_completed([pool.submit(download, i) for i in range(count)]):
            completed += future.result()
            if time.time() - last > 10:
                print(NAME + ' verified ranges: %d/%d bytes' % (completed, SIZE), flush=True)
                last = time.time()
    temporary = DIRECTORY / (FILE + '.assembled')
    sha1 = hashlib.sha1()
    sha256 = hashlib.sha256()
    with temporary.open('wb') as target:
        for index in range(count):
            content = (DIRECTORY / (NAME.lower() + '-ranges') / str(index)).read_bytes()
            sha1.update(content)
            sha256.update(content)
            target.write(content)
    assert sha1.hexdigest() == SHA1
    temporary.replace(DIRECTORY / FILE)
    print(NAME + ' sha256=' + sha256.hexdigest(), flush=True)
