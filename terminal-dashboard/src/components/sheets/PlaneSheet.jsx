import BottomSheet from './BottomSheet'
import PlaneAutomationProject from '../plane/PlaneAutomationProject'

function PlaneSheet({ isOpen, onClose, onApproveTicket, onUpdatePlane }) {
  return (
    <BottomSheet
      isOpen={isOpen}
      onClose={onClose}
      title="⚡ Plane Automation"
      height="full"
    >
      <PlaneAutomationProject
        onApproveTicket={onApproveTicket}
        onUpdatePlane={onUpdatePlane}
      />
    </BottomSheet>
  )
}

export default PlaneSheet
