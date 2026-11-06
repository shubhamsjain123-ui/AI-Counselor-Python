import json, os, base64

_here = os.path.dirname(__file__)
nb_path = os.path.join(_here, "sabcq_musetalk_colab.ipynb")
with open(nb_path) as f:
    nb = json.load(f)

with open(os.path.join(_here, "musetalk_server.py"), "rb") as f:
    server_b64 = base64.b64encode(f.read()).decode("ascii")
with open(os.path.join(_here, "musetalk_warm_engine.py"), "rb") as f:
    warm_b64 = base64.b64encode(f.read()).decode("ascii")

for i, cell in enumerate(nb["cells"]):
    src = "".join(cell.get("source", []))
    if "SERVER_B64" in src or ("musetalk_server.py" in src and ("f.write" in src or "b64decode" in src)):
        nb["cells"][i]["source"] = [
            "# 4. Write SABCQ Warm Engine + Live Server (v3.0 Phase 1)\n",
            "%cd /content/MuseTalk\n",
            "import base64\n",
            f"WARM_B64 = \"{warm_b64}\"\n",
            f"SERVER_B64 = \"{server_b64}\"\n",
            "with open('/content/MuseTalk/musetalk_warm_engine.py', 'wb') as f:\n",
            "    f.write(base64.b64decode(WARM_B64))\n",
            "with open('/content/MuseTalk/musetalk_server.py', 'wb') as f:\n",
            "    f.write(base64.b64decode(SERVER_B64))\n",
            "print('✅ musetalk_warm_engine.py + musetalk_server.py v3.0 written')\n",
        ]
        print("Updated embed cell", i)
        break

with open(nb_path, "w") as f:
    json.dump(nb, f, indent=1)
print("generate_nb refreshed notebook embeds")
