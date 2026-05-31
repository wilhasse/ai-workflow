import * as pulumi from '@pulumi/pulumi'
import * as proxmoxve from '@muhlba91/pulumi-proxmoxve'

type VmSpec = {
  name: string
  node: string
  cpuCores: number
  memoryMb: number
  diskGb: number
  bridge: string
  username: string
  sshPublicKey: string
  description?: string
  template: {
    node: string
    templateVmId: number
    storage: string
  }
}

const config = new pulumi.Config()
const spec = config.requireObject<VmSpec>('spec')

const vm = new proxmoxve.VmLegacy(spec.name, {
  nodeName: spec.node,
  name: spec.name,
  description: spec.description || 'Created from AI Workflow dashboard',
  agent: {
    enabled: true,
    trim: true,
    type: 'virtio',
  },
  bios: 'seabios',
  cpu: {
    cores: spec.cpuCores,
    sockets: 1,
    type: 'x86-64-v2-AES',
  },
  clone: {
    nodeName: spec.template.node,
    vmId: spec.template.templateVmId,
    full: true,
  },
  disks: [
    {
      datastoreId: spec.template.storage,
      fileFormat: 'qcow2',
      interface: 'scsi0',
      size: spec.diskGb,
    },
  ],
  initialization: {
    datastoreId: spec.template.storage,
    ipConfigs: [
      {
        ipv4: {
          address: 'dhcp',
        },
      },
    ],
    type: 'nocloud',
    userAccount: {
      username: spec.username,
      keys: [spec.sshPublicKey],
    },
  },
  memory: {
    dedicated: spec.memoryMb,
  },
  networkDevices: [
    {
      bridge: spec.bridge,
      model: 'virtio',
    },
  ],
  onBoot: false,
  operatingSystem: {
    type: 'l26',
  },
  started: true,
  stopOnDestroy: true,
  tags: ['ai-workflow', 'test-vm'],
})

const legacyVm = vm as unknown as {
  id: pulumi.Output<string>
  vmId?: pulumi.Output<number>
  ipv4Addresses?: pulumi.Output<string[]>
}

export const resourceId = legacyVm.id
export const vmId = legacyVm.vmId
export const ipAddresses = legacyVm.ipv4Addresses || []
export const ipv4 = pulumi.output(legacyVm.ipv4Addresses || []).apply((addresses) => (
  addresses.find((address) => /^\d+\.\d+\.\d+\.\d+/.test(address)) || ''
))
