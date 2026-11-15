# Node.js CRUD (JWT + Mongoose) → Docker → Kubernetes (k3s on DigitalOcean)

A compact end-to-end guide. Order: **build app → containerize → learn K8s → build cluster → deploy → debug.**

---

## 1. The Node.js CRUD app (Express + JWT + Mongoose)

```
app/
├── Dockerfile
├── .dockerignore
├── package.json
└── src/
    ├── index.js
    ├── middleware/auth.js
    ├── models/User.js
    ├── models/Item.js
    └── routes/{auth.js,items.js}
```

```bash
mkdir -p app/src/{middleware,models,routes} && cd app
npm init -y
npm i express mongoose jsonwebtoken bcryptjs dotenv
```

In `package.json` add: `"scripts": { "start": "node src/index.js" }`

**src/index.js**
```js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');

const app = express();
app.use(express.json());

app.get('/health', (_, res) => res.json({ status: 'ok' })); // used by K8s probes
app.use('/auth', require('./routes/auth'));
app.use('/items', require('./routes/items'));

const PORT = process.env.PORT || 3000;
mongoose
  .connect(process.env.MONGO_URI)
  .then(() => app.listen(PORT, () => console.log(`Listening on ${PORT}`)))
  .catch((e) => { console.error('Mongo connection failed', e); process.exit(1); });
```

**src/models/User.js**
```js
const { Schema, model } = require('mongoose');
module.exports = model('User', new Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
}));
```

**src/models/Item.js**
```js
const { Schema, model } = require('mongoose');
module.exports = model('Item', new Schema({
  title: { type: String, required: true },
  description: String,
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
}, { timestamps: true }));
```

**src/middleware/auth.js**
```js
const jwt = require('jsonwebtoken');
module.exports = (req, res, next) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or missing token' });
  }
};
```

**src/routes/auth.js**
```js
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');

router.post('/register', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.create({ email, password: await bcrypt.hash(password, 10) });
    res.status(201).json({ id: user._id, email: user.email });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'Bad credentials' });
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  res.json({ token });
});

module.exports = router;
```

**src/routes/items.js**
```js
const router = require('express').Router();
const auth = require('../middleware/auth');
const Item = require('../models/Item');

router.use(auth);

router.post('/', async (req, res) => {
  const item = await Item.create({ ...req.body, owner: req.user.id });
  res.status(201).json(item);
});
router.get('/', async (req, res) => res.json(await Item.find({ owner: req.user.id })));
router.get('/:id', async (req, res) => {
  const item = await Item.findOne({ _id: req.params.id, owner: req.user.id });
  item ? res.json(item) : res.status(404).json({ error: 'Not found' });
});
router.put('/:id', async (req, res) => {
  const item = await Item.findOneAndUpdate(
    { _id: req.params.id, owner: req.user.id }, req.body, { new: true });
  item ? res.json(item) : res.status(404).json({ error: 'Not found' });
});
router.delete('/:id', async (req, res) => {
  const item = await Item.findOneAndDelete({ _id: req.params.id, owner: req.user.id });
  item ? res.status(204).end() : res.status(404).json({ error: 'Not found' });
});

module.exports = router;
```

**Test (after Docker section, via compose):**
```bash
curl -X POST localhost:3000/auth/register -H 'Content-Type: application/json' -d '{"email":"a@b.com","password":"secret"}'
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"a@b.com","password":"secret"}' | jq -r .token)
curl -X POST localhost:3000/items -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"title":"first"}'
curl localhost:3000/items -H "Authorization: Bearer $TOKEN"
```

---

## 2. Docker

### Core concepts

| Concept | What it is |
|---|---|
| **Image** | Read-only, layered template (your app + runtime + deps). Built from a Dockerfile. |
| **Container** | A running instance of an image (an isolated process using Linux namespaces + cgroups). |
| **Volume** | Docker-managed persistent storage that outlives containers. |
| **Network** | Virtual network so containers can talk to each other (by name on user-defined networks). |
| **Registry** | Where images are stored/pulled (Docker Hub, GHCR, etc.). |

### Dockerfile

**Dockerfile**
```dockerfile
FROM node:20-alpine
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev          # layer cached unless package files change
COPY src ./src
ENV NODE_ENV=production
EXPOSE 3000
USER node                      # don't run as root
CMD ["npm", "start"]
```

**.dockerignore**
```
node_modules
.env
.git
```

### Images

```bash
docker build -t youruser/crud-app:1.0 .
docker images                       # list
docker image rm <id>                # delete
docker login && docker push youruser/crud-app:1.0
docker history youruser/crud-app:1.0   # see layers
```

> Building on an Apple Silicon Mac for x86 droplets? Use `docker build --platform linux/amd64 ...`

### Containers

```bash
docker run -d --name api -p 3000:3000 youruser/crud-app:1.0   # -p host:container
docker ps            # running   (docker ps -a = all)
docker logs -f api
docker exec -it api sh
docker stop api && docker rm api
```

### Volumes

```bash
docker volume create mongo-data
docker run -d --name mongo -v mongo-data:/data/db mongo:7
docker volume ls
docker volume inspect mongo-data
```
Bind mount (host folder → container): `-v $(pwd)/data:/data/db`

### Networks

```bash
docker network create appnet
docker run -d --name mongo --network appnet -v mongo-data:/data/db mongo:7
docker run -d --name api --network appnet -p 3000:3000 \
  -e MONGO_URI=mongodb://mongo:27017/crudapp -e JWT_SECRET=devsecret youruser/crud-app:1.0
docker network ls
docker network inspect appnet
```
Drivers: `bridge` (default, single host), `host` (shares host network), `none`, `overlay` (multi-host/Swarm).
On a **user-defined** bridge, containers resolve each other by **name** (`mongo`).

### docker-compose (run everything locally)

**docker-compose.yml**
```yaml
services:
  mongo:
    image: mongo:7
    volumes: [mongo-data:/data/db]
  api:
    build: .
    ports: ["3000:3000"]
    environment:
      MONGO_URI: mongodb://mongo:27017/crudapp
      JWT_SECRET: devsecret        # local dev ONLY. In the cluster the secret is created with kubectl (§6.1)
    depends_on: [mongo]
volumes:
  mongo-data:
```
```bash
docker compose up -d --build
docker compose logs -f api
docker compose down          # add -v to also delete volumes
```

Push the image so the cluster can pull it:
```bash
docker push youruser/crud-app:1.0
```

---

## 3. Kubernetes fundamentals

Docker runs containers on **one** machine. Kubernetes (K8s) runs them across **many** machines and keeps them healthy: scheduling, self-healing, scaling, rolling updates, service discovery.

You describe **desired state** in YAML; K8s controllers continuously reconcile **actual state** to match it.

### Internal architecture

```
                 ┌────────────── CONTROL PLANE (master) ──────────────┐
 kubectl ──────► │ kube-apiserver  ◄──►  etcd (cluster state DB)      │
                 │ kube-scheduler (picks node for new pods)           │
                 │ controller-manager (reconcile loops: RS, node...)  │
                 └───────────────────────┬────────────────────────────┘
                                         │
              ┌──────────────────────────┴───────────────────────┐
        ┌─────▼──────── WORKER NODE ───────┐      ┌─────── WORKER NODE ───────┐
        │ kubelet (runs/monitors pods)     │ ...  │ kubelet                   │
        │ kube-proxy (service networking)  │      │ kube-proxy                │
        │ container runtime (containerd)   │      │ containerd                │
        │  [Pod] [Pod] [Pod]               │      │  [Pod] [Pod]              │
        └──────────────────────────────────┘      └───────────────────────────┘
```

| Component | Role |
|---|---|
| **kube-apiserver** | Front door. Every command/component talks to it (REST). |
| **etcd** | Key-value store holding all cluster state. |
| **scheduler** | Assigns unscheduled pods to nodes (resources, affinity, taints). |
| **controller-manager** | Runs controllers (ReplicaSet, Node, Deployment…) that reconcile state. |
| **kubelet** | Node agent; starts containers via the runtime and reports status. |
| **kube-proxy** | Programs iptables/IPVS so Services route to pods. |
| **container runtime** | containerd/CRI-O; actually runs containers. |

**k3s** is a lightweight, single-binary K8s distro (great for small VPSes). It bundles: SQLite/etcd, containerd, Traefik ingress, CoreDNS, metrics-server, local-path storage provisioner, and ServiceLB. "Server" = master, "agent" = worker.

---

## 4. Build the cluster: 2 DigitalOcean droplets + k3s

### 4.1 Create the droplets
1. Sign up at digitalocean.com → **Create → Droplets**.
2. Image: **Ubuntu 24.04**. Size: **2 GB RAM / 1 vCPU** minimum (master), 2 GB for worker.
3. **Same region and same VPC** for both (they get private IPs, e.g. `10.x.x.x`).
4. Auth: add your **SSH key**. Name them `k3s-master` and `k3s-worker`.
5. Note: master public IP (`MASTER_PUB`), master private IP (`MASTER_PRIV`).

### 4.2 Firewall (Networking → Firewalls)
Apply to both droplets.

| Port | Proto | Source | Why |
|---|---|---|---|
| 22 | TCP | your IP | SSH |
| 6443 | TCP | your IP + worker | K8s API |
| 8472 | UDP | the two droplets | Flannel VXLAN (pod network) |
| 10250 | TCP | the two droplets | kubelet |
| 30000-32767 | TCP | anywhere | NodePort services |
| 80/443 | TCP | anywhere | Only if using ingress |

### 4.3 Install the master (server)
```bash
ssh root@MASTER_PUB
curl -sfL https://get.k3s.io | sh -s - \
  --tls-san MASTER_PUB \
  --node-ip MASTER_PRIV \
  --advertise-address MASTER_PRIV \
  --flannel-iface eth1          # eth1 = VPC interface on DO (check with `ip a`)
sudo k3s kubectl get nodes      # should show Ready
sudo cat /var/lib/rancher/k3s/server/node-token   # copy this token
```

### 4.4 Install the worker (agent)
```bash
ssh root@WORKER_PUB
curl -sfL https://get.k3s.io | \
  K3S_URL=https://MASTER_PRIV:6443 \
  K3S_TOKEN=<token-from-master> \
  sh -s - --node-ip WORKER_PRIV --flannel-iface eth1
```
Back on the master: `sudo k3s kubectl get nodes -o wide` → two nodes `Ready`.

### 4.5 Get the kubeconfig onto your laptop
```bash
scp root@MASTER_PUB:/etc/rancher/k3s/k3s.yaml ~/k3s.yaml
sed -i 's/127.0.0.1/MASTER_PUB/' ~/k3s.yaml        # macOS: sed -i '' ...
export KUBECONFIG=~/k3s.yaml
kubectl get nodes
```
(Install kubectl first: https://kubernetes.io/docs/tasks/tools/). To keep it permanent, merge into `~/.kube/config` or add the `export` to your shell profile.

### 4.6 SSH into a node and see what's running

`kubectl` shows what Kubernetes *believes* is running. SSH shows what the node is *actually* doing. Try `kubectl` first. SSH in when a node itself looks wrong: `NotReady`, a pod stuck in `ContainerCreating`, a full disk, or k3s errors.

**1. Find which node the pod is on, then connect to that node**
```bash
kubectl get pods -n crud -o wide        # the NODE column says k3s-master or k3s-worker
ssh root@MASTER_PUB                     # or WORKER_PUB
ssh -i ~/.ssh/my_key root@WORKER_PUB    # if your key isn't the default one
```
| Part | Meaning |
|---|---|
| `root@IP` | Log in as user `root` at the droplet's **public** IP (the SSH key you added when creating the droplet) |
| `-i ~/.ssh/my_key` | Which private key to use |
| port 22 | Must be open in the DigitalOcean firewall for **your IP** (§4.2). If your home IP changes, update the rule |

**2. On the master: `kubectl` works locally**
```bash
sudo k3s kubectl get nodes -o wide
sudo k3s kubectl get pods -A -o wide     # every pod, every namespace, with node + IP
sudo k3s kubectl get pods -n crud
```
`k3s kubectl` is the `kubectl` bundled in k3s. On the master it finds the admin kubeconfig (`/etc/rancher/k3s/k3s.yaml`) by itself.

> The **worker** only runs the k3s *agent*. It has no admin kubeconfig, so `k3s kubectl` there usually fails with "connection refused". Use `crictl` (next step) or run `kubectl` from your laptop.

**3. On any node: see the containers running on that node**

k3s uses **containerd**, not Docker, so `docker ps` shows nothing. Use `crictl`, which talks to containerd directly:
```bash
sudo k3s crictl pods                                   # pod sandboxes on THIS node
sudo k3s crictl ps                                     # running containers (add -a to include exited ones)
sudo k3s crictl ps --label io.kubernetes.pod.namespace=crud   # only containers of the crud namespace
sudo k3s crictl ps --name api                          # filter by container name
sudo k3s crictl logs <container-id>                    # logs (get the ID from `crictl ps`)
sudo k3s crictl logs --tail 50 -f <container-id>       # last 50 lines, then follow
sudo k3s crictl exec -it <container-id> sh             # shell inside the container
sudo k3s crictl stats                                  # CPU / memory per container
sudo k3s crictl images                                 # images already pulled on this node
```
`crictl ps` lists container ID, image, state, name and the pod it belongs to. You only need the first few characters of an ID.

> Look, don't fix, from here. If you `crictl stop` or `rm` a container, the kubelet just recreates it. To restart something properly use `kubectl delete pod <pod> -n crud` from your laptop.

**4. Is the node itself healthy?**
```bash
sudo systemctl status k3s              # master  (the worker's service is called k3s-agent)
sudo systemctl status k3s-agent        # worker
sudo journalctl -u k3s -n 100 --no-pager     # master: last 100 log lines
sudo journalctl -u k3s-agent -f              # worker: follow the log live (Ctrl+C to stop)
uptime && free -h && df -h             # load, memory, disk (a full disk breaks pulls and pods)
ss -tlnp | grep -E '6443|10250'        # 6443 = API (master), 10250 = kubelet
sudo ls /var/log/pods                  # raw pod log files kept by the kubelet
```
| Command | What it tells you |
|---|---|
| `systemctl status k3s` / `k3s-agent` | Is the k3s service running, or crash-looping? |
| `journalctl -u … -f` | The reason: joins failing, wrong token, image pull errors, network problems |
| `free -h` / `df -h` | Out of memory or disk, a classic cause of evicted or stuck pods |
| `ss -tlnp` | Which ports are listening, and which process owns them |

**No SSH? Use a debug pod on the node** (run from your laptop):
```bash
kubectl debug node/k3s-worker -it --image=busybox     # node name from `kubectl get nodes`
# inside: the node's filesystem is mounted at /host   →   chroot /host
kubectl get pods                                      # a pod named node-debugger-… was created
kubectl delete pod node-debugger-<suffix>             # clean it up when you're done
```

---

## 5. Kubernetes objects (what you'll deploy)

| Object | Purpose |
|---|---|
| **Pod** | Smallest unit; one or more containers sharing network/storage. Ephemeral — gets a new IP when recreated. |
| **ReplicaSet (RS)** | Ensures N identical pods are running. Rarely created directly. |
| **Deployment** | Manages ReplicaSets; adds **rolling updates and rollbacks**. Use for stateless apps. |
| **Service** | Stable virtual IP + DNS name in front of pods (selected by labels). Types: `ClusterIP` (internal, default), `NodePort` (exposes on every node), `LoadBalancer`, headless (`clusterIP: None`, per-pod DNS). |
| **StatefulSet** | Like Deployment but for stateful apps: stable names (`mongo-0`), ordered start/stop, **its own PVC per pod**. |
| **HPA** | HorizontalPodAutoscaler: scales replicas by CPU/memory (needs metrics-server + resource requests). |
| **ConfigMap / Secret** | Config / sensitive config injected as env vars or files. |
| **PVC / PV / StorageClass** | Request & provision persistent storage (k3s default: `local-path`). |
| **Namespace** | Logical partition of cluster resources. |

Relationship: `Deployment → ReplicaSet → Pods`, `Service → (label selector) → Pods`.

---

## 6. Deploy the app

Create a folder `k8s/` for the YAML files. **Secrets are the exception: they are never written to a file.** You create them with `kubectl` straight in the cluster, so nothing sensitive ever sits in the repo or gets pushed to GitHub.

### 6.1 Namespace (YAML) + Secret (command line)

**k8s/00-namespace.yaml**
```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: crud
```
```bash
kubectl apply -f k8s/00-namespace.yaml
```

Now create the Secret. The namespace must exist first.

```bash
kubectl -n crud create secret generic app-secret \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=MONGO_URI="mongodb://mongo-0.mongo.crud.svc.cluster.local:27017/crudapp"
```

| Part | Meaning |
|---|---|
| `-n crud` | Create it in the `crud` namespace (same one as the Deployment) |
| `create secret generic app-secret` | A Secret of type `Opaque`, named `app-secret` (the name the Deployment's `secretRef` uses) |
| `--from-literal=KEY=VALUE` | One key/value pair; each key becomes an environment variable in the pod |
| `$(openssl rand -base64 48)` | The shell runs this first and pastes in a fresh random string. You never type or see the secret, and it is not in the repo |

The Deployment in §6.3 is unchanged. It still uses `envFrom: secretRef: app-secret`, which turns every key in the Secret into an env var.

**Check it** (values are hidden unless you ask for them):
```bash
kubectl -n crud get secret app-secret                  # exists? shows type and key count
kubectl -n crud describe secret app-secret             # key names + sizes, NOT the values
kubectl -n crud get secret app-secret -o jsonpath='{.data.MONGO_URI}' | base64 -d; echo
```
The last line prints one value: `-o jsonpath=...` picks the field, `base64 -d` decodes it.

> **Base64 is encoding, not encryption.** Anyone who can run `get secret` in this namespace can read every value. Protect your kubeconfig like a password.

**Want to choose the value yourself?** Use a silent prompt so it never appears on screen or in your shell history:
```bash
read -rs JWT_SECRET        # type or paste, nothing is echoed
kubectl -n crud create secret generic app-secret \
  --from-literal=JWT_SECRET="$JWT_SECRET" \
  --from-literal=MONGO_URI="mongodb://mongo-0.mongo.crud.svc.cluster.local:27017/crudapp"
unset JWT_SECRET
```

**Change (rotate) it later.** `create` fails if the Secret already exists, so generate the YAML on the fly and pipe it straight to `apply` (nothing is saved to disk):
```bash
kubectl -n crud create secret generic app-secret \
  --from-literal=JWT_SECRET="$(openssl rand -base64 48)" \
  --from-literal=MONGO_URI="mongodb://mongo-0.mongo.crud.svc.cluster.local:27017/crudapp" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n crud rollout restart deployment/crud-app      # env vars are read only when a pod starts
```
`--dry-run=client -o yaml` means "build the object and print it as YAML, don't send it". `kubectl apply` then updates the real Secret. You may see a harmless warning about a missing `last-applied-configuration` annotation, because the Secret was first made with `create`. Rotating `JWT_SECRET` invalidates every issued token, so all users have to log in again.

Delete it: `kubectl -n crud delete secret app-secret`.

> **Keep it out of Git:** add `*secret*.yaml` to `.gitignore` in case someone later saves one by habit. If you ever want secrets *in* Git, encrypt them first (Sealed Secrets or SOPS, see §8).

### 6.2 MongoDB as a StatefulSet (+ headless Service)
**10-mongo.yaml**
```yaml
apiVersion: v1
kind: Service
metadata:
  name: mongo
  namespace: crud
spec:
  clusterIP: None            # headless → gives pods DNS: mongo-0.mongo
  selector:
    app: mongo
  ports:
    - port: 27017
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongo
  namespace: crud
spec:
  serviceName: mongo
  replicas: 1
  selector:
    matchLabels:
      app: mongo
  template:
    metadata:
      labels:
        app: mongo
    spec:
      containers:
        - name: mongo
          image: mongo:7
          ports:
            - containerPort: 27017
          volumeMounts:
            - name: data
              mountPath: /data/db
          resources:
            requests: { cpu: 100m, memory: 256Mi }
  volumeClaimTemplates:        # one PVC per pod, survives pod restarts
    - metadata:
        name: data
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: local-path
        resources:
          requests:
            storage: 2Gi
```

### 6.3 App Deployment + Service (NodePort)
**20-app.yaml**
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: crud-app
  namespace: crud
spec:
  replicas: 2
  selector:
    matchLabels:
      app: crud-app
  template:
    metadata:
      labels:
        app: crud-app
    spec:
      containers:
        - name: api
          image: youruser/crud-app:1.0     # <-- your pushed image
          ports:
            - containerPort: 3000
          envFrom:
            - secretRef:
                name: app-secret
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits:   { cpu: 500m, memory: 256Mi }
          readinessProbe:                  # traffic only when ready
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 5
          livenessProbe:                   # restart if it hangs
            httpGet: { path: /health, port: 3000 }
            initialDelaySeconds: 15
---
apiVersion: v1
kind: Service
metadata:
  name: crud-app
  namespace: crud
spec:
  type: NodePort
  selector:
    app: crud-app
  ports:
    - port: 80
      targetPort: 3000
      nodePort: 30080
```

> Private Docker Hub repo? Create a pull secret the same way, from the command line (never a YAML file):
> `kubectl create secret docker-registry regcred -n crud --docker-username=... --docker-password=... ` and add `imagePullSecrets: [{name: regcred}]` to the pod spec.

### 6.4 HPA
**30-hpa.yaml**
```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: crud-app
  namespace: crud
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: crud-app
  minReplicas: 2
  maxReplicas: 6
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
```

### 6.5 Apply & test
```bash
kubectl apply -f k8s/00-namespace.yaml
# create the Secret ONCE: run the `kubectl create secret` command from §6.1 (nothing to apply from a file)
kubectl -n crud get secret app-secret                 # confirm it exists before the app starts
kubectl apply -f k8s/10-mongo.yaml
kubectl -n crud rollout status statefulset/mongo
kubectl apply -f k8s/20-app.yaml -f k8s/30-hpa.yaml
kubectl -n crud get all

curl http://WORKER_PUB:30080/health      # NodePort works on ANY node's public IP
```
Then repeat the register/login/items `curl` commands from section 1 using `http://MASTER_PUB:30080`.

**Update the app (rolling update) / rollback**
```bash
kubectl -n crud set image deployment/crud-app api=youruser/crud-app:1.1
kubectl -n crud rollout status deployment/crud-app
kubectl -n crud rollout undo deployment/crud-app
```

**Scale manually**
```bash
kubectl -n crud scale deployment crud-app --replicas=4   # HPA will override within its min/max
```

---

## 7. kubectl essentials

Tip: `alias k=kubectl` and `kubectl config set-context --current --namespace=crud`.

### Inspect
```bash
kubectl cluster-info
kubectl get nodes -o wide
kubectl get pods -n crud -o wide          # -o wide shows node + IP
kubectl get all -n crud
kubectl get pods -A                       # all namespaces
kubectl get pod <pod> -o yaml
kubectl api-resources                     # list resource kinds
kubectl explain deployment.spec           # built-in docs
```

### Create / change / delete
```bash
kubectl apply -f file.yaml                # create or update (declarative)
kubectl delete -f file.yaml
kubectl delete pod <pod> -n crud          # RS/Deployment recreates it
kubectl edit deployment crud-app -n crud
kubectl create secret generic x --from-literal=K=V -n crud
```

### Debug (in rough order of use)
```bash
kubectl get pods -n crud                              # 1. status? Pending / CrashLoopBackOff / ImagePullBackOff?
kubectl describe pod <pod> -n crud                    # 2. Events at bottom explain most failures
kubectl logs <pod> -n crud                            # 3. app logs
kubectl logs <pod> -n crud --previous                 #    logs of the crashed prior container
kubectl logs -f -l app=crud-app -n crud               #    stream logs for all pods with label
kubectl exec -it <pod> -n crud -- sh                  # 4. shell inside the container
kubectl get events -n crud --sort-by=.lastTimestamp   # 5. cluster events
kubectl top nodes && kubectl top pods -n crud         # 6. CPU/mem (metrics-server)
kubectl port-forward svc/crud-app 8080:80 -n crud     # 7. test a service from your laptop
kubectl get endpoints crud-app -n crud                #    empty = selector doesn't match pods / pods not ready
kubectl run tmp --rm -it --image=busybox -n crud -- sh   # throwaway pod to test DNS/connectivity
# 8. still unexplained, or a node is NotReady? SSH into the node → §4.6 (crictl ps, journalctl -u k3s-agent, df -h)
```

### Common failures

| Symptom | Likely cause / fix |
|---|---|
| `ImagePullBackOff` | Wrong image name/tag, private repo without pull secret, or wrong CPU arch. |
| `CrashLoopBackOff` | App crashing → `logs --previous`. Often bad `MONGO_URI`/missing env. |
| `Pending` | No node has enough resources, or PVC unbound → `describe pod`. |
| Service unreachable | `get endpoints` empty; label/selector mismatch; readiness probe failing; firewall blocking NodePort. |
| `kubectl` timeout from laptop | Port 6443 blocked, or kubeconfig still points at `127.0.0.1`, or missing `--tls-san`. |
| HPA shows `<unknown>` | metrics-server not ready or pods lack `resources.requests`. |
| Node `NotReady` | SSH to it (§4.6): `systemctl status k3s-agent`, `journalctl -u k3s-agent -n 100`, then check the firewall (8472/udp, 10250/tcp) and disk (`df -h`). |
| Pod stuck `ContainerCreating` | `describe pod` Events first. Then on its node: `sudo k3s crictl images` (is the image pulled?), `journalctl -u k3s-agent`, `df -h`. |
| Secret missing / `CreateContainerConfigError` | The Secret wasn't created before the app. Run the `kubectl create secret` command from §6.1, then `kubectl -n crud rollout restart deployment/crud-app`. |

### Cheat-sheet: cleanup
```bash
kubectl delete namespace crud            # removes everything in it (PVCs too)
# uninstall k3s:  /usr/local/bin/k3s-uninstall.sh (master)  /usr/local/bin/k3s-agent-uninstall.sh (worker)
```

---

## 8. Next steps
- **Ingress + TLS:** k3s ships Traefik; add an `Ingress` + cert-manager for a real domain with HTTPS.
- **Mongo HA:** use a 3-replica replica set (or MongoDB Atlas) instead of a single pod.
- **Config hygiene:** move non-secret config to a `ConfigMap`; never commit real secrets. Create them with `kubectl create secret` (§6.1) or encrypt them with sealed-secrets/SOPS.
- **CI/CD:** GitHub Actions → build & push image → `kubectl set image` or Helm/Argo CD.
- **Costs:** destroy droplets when finished — DigitalOcean bills while they exist.